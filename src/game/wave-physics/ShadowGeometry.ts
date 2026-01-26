/**
 * Shadow Geometry
 *
 * Builds shadow regions from silhouette points. Each shadow region is defined by:
 * - Two boundary lines extending from silhouette points in the wave direction
 * - The coastline segment between those points (the "obstacle")
 * - The obstacle width (distance between silhouette points)
 *
 * Shadow polygons are used for:
 * 1. Rasterization to a shadow texture (ShadowTextureRenderer)
 * 2. Per-pixel distance calculations in the wave shader
 */

import { V, V2d } from "../../core/Vector";
import { catmullRomPoint } from "../../core/util/Spline";
import type { TerrainContour } from "../world-data/terrain/LandMass";
import type { AABB } from "./CoastlineManager";
import {
  type SilhouettePoint,
  groupSilhouettePointsByContour,
} from "./SilhouetteComputation";

/**
 * Simplified shadow polygon data for GPU rendering and uniform buffers.
 *
 * This is the primary data structure for the texture-based shadow system.
 * It contains everything needed to:
 * 1. Render the polygon to the shadow texture (vertices, polygonIndex)
 * 2. Compute Fresnel diffraction distances in the shader (silhouette points, obstacleWidth)
 */
export interface ShadowPolygonRenderData {
  /** Polygon vertices in world space (for rasterization) */
  vertices: V2d[];
  /** Coastline vertices from right to left silhouette (for rasterization) */
  coastlineVertices: V2d[];
  /** Index of this polygon (for identification in shader) */
  polygonIndex: number;
  /** Left silhouette point (for distance calculations) */
  leftSilhouette: V2d;
  /** Right silhouette point (for distance calculations) */
  rightSilhouette: V2d;
  /** Distance between silhouette points (perpendicular to wave direction) */
  obstacleWidth: number;
  /** Contour index this shadow comes from */
  contourIndex: number;
}

/**
 * A shadow boundary line extending from a silhouette point.
 */
export interface ShadowBoundary {
  /** Origin point (silhouette point on coastline) */
  origin: V2d;
  /** Direction the boundary extends (same as wave direction) */
  direction: V2d;
  /** Index of the coastline contour this came from */
  contourIndex: number;
  /** Whether this is the left edge of the shadow (true) or right edge (false) */
  isLeftEdge: boolean;
  /** Index of the paired boundary (other edge of the same shadow) */
  pairedBoundaryIndex: number;
}

/**
 * A shadow polygon representing the shadow region behind an obstacle.
 */
export interface ShadowPolygon {
  /** Index of the left boundary in the boundaries array */
  leftBoundaryIndex: number;
  /** Index of the right boundary in the boundaries array */
  rightBoundaryIndex: number;
  /** Width of the obstacle (distance between silhouette points) */
  obstacleWidth: number;
  /** Bounding box of the shadow polygon (for early rejection) */
  bounds: AABB;
  /** Contour index this shadow comes from */
  contourIndex: number;
  /** Index into the coastlinePoints array where this polygon's points start */
  coastlinePointsStart: number;
  /** Number of coastline sample points (always COASTLINE_POLYGON_SAMPLES) */
  coastlinePointsCount: number;
}

/**
 * Complete shadow geometry for a single wave direction.
 */
export interface ShadowGeometryData {
  /** All shadow boundaries */
  boundaries: ShadowBoundary[];
  /** All shadow polygons */
  polygons: ShadowPolygon[];
  /** All coastline sample points (flat array, referenced by polygons) */
  coastlinePoints: V2d[];
  /** The wave direction this geometry is computed for */
  waveDirection: V2d;
}

/** Maximum distance to extend shadow boundaries (world units) */
const SHADOW_EXTEND_DISTANCE = 50000;

/** Number of coastline sample points per shadow polygon */
export const COASTLINE_POLYGON_SAMPLES = 32;

/**
 * Sample a point on the spline at the given parameter value.
 */
function sampleSplineAtParam(contour: TerrainContour, param: number): V2d {
  const controlPoints = contour.controlPoints;
  const n = controlPoints.length;

  // Wrap param to [0, n) range
  while (param < 0) param += n;
  while (param >= n) param -= n;

  const segIdx = Math.floor(param);
  const t = param - segIdx;

  const i0 = (segIdx - 1 + n) % n;
  const i1 = segIdx;
  const i2 = (segIdx + 1) % n;
  const i3 = (segIdx + 2) % n;

  return catmullRomPoint(
    controlPoints[i0],
    controlPoints[i1],
    controlPoints[i2],
    controlPoints[i3],
    t,
  );
}

/**
 * Sample coastline points along a specific arc direction.
 */
function sampleArc(
  contour: TerrainContour,
  rightParam: number,
  leftParam: number,
  goBackward: boolean,
): V2d[] {
  const n = contour.controlPoints.length;
  const points: V2d[] = [];

  // Calculate arc length
  let arcLength: number;
  if (goBackward) {
    // Backwards traversal: rightParam -> leftParam (decreasing)
    if (rightParam > leftParam) {
      arcLength = rightParam - leftParam;
    } else {
      arcLength = rightParam + (n - leftParam);
    }
  } else {
    // Forwards traversal: rightParam -> leftParam (increasing)
    if (leftParam > rightParam) {
      arcLength = leftParam - rightParam;
    } else {
      arcLength = leftParam + (n - rightParam);
    }
  }

  // Sample evenly along this arc
  for (let i = 0; i < COASTLINE_POLYGON_SAMPLES; i++) {
    const fraction = i / (COASTLINE_POLYGON_SAMPLES - 1);
    let param: number;
    if (goBackward) {
      param = rightParam - fraction * arcLength;
    } else {
      param = rightParam + fraction * arcLength;
    }
    points.push(sampleSplineAtParam(contour, param));
  }

  return points;
}

/**
 * Sample coastline points along the leeward arc between two silhouette points.
 *
 * The leeward arc is the side of the island facing AWAY from the incoming waves,
 * which is the side that bounds the shadow region. This is the coastline that
 * waves diffract around, so it defines where the shadow actually is.
 *
 * We determine which arc (forward or backward traversal) is leeward by sampling
 * the midpoint of each potential arc and checking which one is further in the
 * wave direction (i.e., closer to the shadow region).
 *
 * @param contour - The coastline contour
 * @param rightPoint - Right silhouette point (start of arc)
 * @param leftPoint - Left silhouette point (end of arc)
 * @param waveDir - The wave propagation direction
 * @returns Array of sampled coastline points from right to left via leeward side
 */
function sampleLeewardCoastlineArc(
  contour: TerrainContour,
  rightPoint: SilhouettePoint,
  leftPoint: SilhouettePoint,
  waveDir: V2d,
): V2d[] {
  const rightParam = rightPoint.segmentIndex + rightPoint.t;
  const leftParam = leftPoint.segmentIndex + leftPoint.t;
  const n = contour.controlPoints.length;

  // Calculate midpoint parameters for both arcs
  // Forward arc: rightParam -> leftParam (increasing, with wrap)
  let forwardMidParam: number;
  if (leftParam > rightParam) {
    forwardMidParam = (rightParam + leftParam) / 2;
  } else {
    // Wraps around
    const arcLength = leftParam + (n - rightParam);
    forwardMidParam = rightParam + arcLength / 2;
    if (forwardMidParam >= n) forwardMidParam -= n;
  }

  // Backward arc: rightParam -> leftParam (decreasing, with wrap)
  let backwardMidParam: number;
  if (rightParam > leftParam) {
    backwardMidParam = (rightParam + leftParam) / 2;
  } else {
    // Wraps around
    const arcLength = rightParam + (n - leftParam);
    backwardMidParam = rightParam - arcLength / 2;
    if (backwardMidParam < 0) backwardMidParam += n;
  }

  // Sample both midpoints
  const forwardMid = sampleSplineAtParam(contour, forwardMidParam);
  const backwardMid = sampleSplineAtParam(contour, backwardMidParam);

  // The leeward midpoint is the one further along the wave direction
  // (i.e., has a larger dot product with waveDir)
  const forwardDot = forwardMid.dot(waveDir);
  const backwardDot = backwardMid.dot(waveDir);

  // Use the arc whose midpoint is more in the wave direction (leeward side)
  const goBackward = backwardDot > forwardDot;

  return sampleArc(contour, rightParam, leftParam, goBackward);
}

/**
 * Build shadow geometry from silhouette points and coastline contours.
 *
 * Each contour creates exactly ONE shadow polygon, defined by:
 * - The leftmost silhouette point (perpendicular to wave direction)
 * - The rightmost silhouette point (perpendicular to wave direction)
 *
 * This creates a single shadow region per island that spans from edge to edge.
 *
 * @param silhouettePoints - All silhouette points for this wave direction
 * @param contours - Array of coastline contours
 * @param waveDir - Normalized wave direction
 * @returns Complete shadow geometry data
 */
export function buildShadowGeometry(
  silhouettePoints: SilhouettePoint[],
  contours: { contour: TerrainContour; contourIndex: number }[],
  waveDir: V2d,
): ShadowGeometryData {
  const boundaries: ShadowBoundary[] = [];
  const polygons: ShadowPolygon[] = [];
  const coastlinePoints: V2d[] = [];

  // Group silhouette points by contour
  const pointsByContour = groupSilhouettePointsByContour(silhouettePoints);

  // Build contour lookup map
  const contourMap = new Map<number, TerrainContour>();
  for (const { contour, contourIndex } of contours) {
    contourMap.set(contourIndex, contour);
  }

  // For each contour, find the extremal silhouette points to create ONE shadow
  for (const [contourIndex, points] of pointsByContour) {
    const contour = contourMap.get(contourIndex);
    if (!contour || points.length < 2) continue;

    // Find the leftmost and rightmost silhouette points perpendicular to wave direction.
    //
    // We rotate each point into a coordinate frame where waveDir points along +Y (downward).
    // In this frame:
    //   rotatedX = point.x * waveDir.y - point.y * waveDir.x
    //
    // This is equivalent to the 2D cross product: waveDir × point
    // - Negative rotatedX = left of wave direction
    // - Positive rotatedX = right of wave direction
    //
    // We select:
    // - leftPoint = minimum rotatedX (furthest left)
    // - rightPoint = maximum rotatedX (furthest right)

    let leftPoint: SilhouettePoint | null = null;
    let rightPoint: SilhouettePoint | null = null;
    let minRotatedX = Infinity;
    let maxRotatedX = -Infinity;

    for (const point of points) {
      // Cross product gives signed perpendicular distance
      const rotatedX =
        point.position.x * waveDir.y - point.position.y * waveDir.x;

      if (rotatedX < minRotatedX) {
        minRotatedX = rotatedX;
        leftPoint = point;
      }
      if (rotatedX > maxRotatedX) {
        maxRotatedX = rotatedX;
        rightPoint = point;
      }
    }

    if (!leftPoint || !rightPoint || leftPoint === rightPoint) continue;

    // Create shadow boundaries from the extremal points
    const leftBoundaryIndex = boundaries.length;
    const rightBoundaryIndex = boundaries.length + 1;

    boundaries.push({
      origin: leftPoint.position,
      direction: waveDir,
      contourIndex,
      isLeftEdge: true,
      pairedBoundaryIndex: rightBoundaryIndex,
    });

    boundaries.push({
      origin: rightPoint.position,
      direction: waveDir,
      contourIndex,
      isLeftEdge: false,
      pairedBoundaryIndex: leftBoundaryIndex,
    });

    // Compute obstacle width (perpendicular span of the island)
    const obstacleWidth = maxRotatedX - minRotatedX;

    // Sample coastline points along the leeward arc (shadow-facing side)
    const coastlinePointsStart = coastlinePoints.length;
    const sampledCoastline = sampleLeewardCoastlineArc(
      contour,
      rightPoint,
      leftPoint,
      waveDir,
    );
    coastlinePoints.push(...sampledCoastline);

    // Compute bounding box for the shadow polygon using the actual sampled coastline
    const bounds = computeShadowPolygonBounds(
      leftPoint.position,
      rightPoint.position,
      waveDir,
      sampledCoastline,
    );

    polygons.push({
      leftBoundaryIndex,
      rightBoundaryIndex,
      obstacleWidth,
      bounds,
      contourIndex,
      coastlinePointsStart,
      coastlinePointsCount: COASTLINE_POLYGON_SAMPLES,
    });
  }

  return {
    boundaries,
    polygons,
    coastlinePoints,
    waveDirection: waveDir,
  };
}

/**
 * Compute bounding box for a shadow polygon.
 * Includes the sampled coastline points and the shadow region extending behind.
 */
function computeShadowPolygonBounds(
  leftOrigin: V2d,
  rightOrigin: V2d,
  waveDir: V2d,
  coastlineSamples: V2d[],
): AABB {
  // Start with the silhouette point positions
  let minX = Math.min(leftOrigin.x, rightOrigin.x);
  let maxX = Math.max(leftOrigin.x, rightOrigin.x);
  let minY = Math.min(leftOrigin.y, rightOrigin.y);
  let maxY = Math.max(leftOrigin.y, rightOrigin.y);

  // Add the extended shadow boundary endpoints
  const extendedLeft = leftOrigin.add(waveDir.mul(SHADOW_EXTEND_DISTANCE));
  const extendedRight = rightOrigin.add(waveDir.mul(SHADOW_EXTEND_DISTANCE));

  minX = Math.min(minX, extendedLeft.x, extendedRight.x);
  maxX = Math.max(maxX, extendedLeft.x, extendedRight.x);
  minY = Math.min(minY, extendedLeft.y, extendedRight.y);
  maxY = Math.max(maxY, extendedLeft.y, extendedRight.y);

  // Include all sampled coastline points
  for (const pt of coastlineSamples) {
    minX = Math.min(minX, pt.x);
    maxX = Math.max(maxX, pt.x);
    minY = Math.min(minY, pt.y);
    maxY = Math.max(maxY, pt.y);
  }

  return { minX, maxX, minY, maxY };
}

/**
 * Test if a point is inside a shadow polygon.
 * Uses a simplified point-in-polygon test based on the boundary lines.
 *
 * @param point - World position to test
 * @param polygon - Shadow polygon to test against
 * @param boundaries - All shadow boundaries
 * @param waveDir - Wave direction
 * @returns True if point is in shadow
 */
export function isPointInShadowPolygon(
  point: V2d,
  polygon: ShadowPolygon,
  boundaries: ShadowBoundary[],
  waveDir: V2d,
): boolean {
  const leftBoundary = boundaries[polygon.leftBoundaryIndex];
  const rightBoundary = boundaries[polygon.rightBoundaryIndex];

  // Point must be "behind" both silhouette points (positive distance along wave direction)
  const toPointFromLeft = point.sub(leftBoundary.origin);
  const toPointFromRight = point.sub(rightBoundary.origin);

  const distBehindLeft = toPointFromLeft.dot(waveDir);
  const distBehindRight = toPointFromRight.dot(waveDir);

  if (distBehindLeft < 0 && distBehindRight < 0) {
    return false; // Point is in front of the obstacle
  }

  // Point must be between the two boundary lines
  // Use cross product to determine which side of each line the point is on
  const perpRight = V(waveDir.y, -waveDir.x); // 90° clockwise from wave dir

  const leftDist = toPointFromLeft.dot(perpRight);
  const rightDist = toPointFromRight.dot(perpRight);

  // Point is in shadow if it's to the right of the left boundary
  // and to the left of the right boundary
  // (relative to wave direction)
  return leftDist >= 0 && rightDist <= 0;
}

/**
 * Find the distance from a point to a shadow boundary line.
 *
 * @param point - World position
 * @param boundary - Shadow boundary
 * @returns Perpendicular distance to the boundary line
 */
export function distanceToShadowBoundary(
  point: V2d,
  boundary: ShadowBoundary,
): number {
  const toPoint = point.sub(boundary.origin);
  const perpRight = V(boundary.direction.y, -boundary.direction.x);
  return Math.abs(toPoint.dot(perpRight));
}

/**
 * Get the distance a point is behind a silhouette point along the wave direction.
 *
 * @param point - World position
 * @param silhouetteOrigin - Silhouette point position
 * @param waveDir - Wave direction
 * @returns Distance behind (positive = behind, negative = in front)
 */
export function distanceBehindSilhouette(
  point: V2d,
  silhouetteOrigin: V2d,
  waveDir: V2d,
): number {
  return point.sub(silhouetteOrigin).dot(waveDir);
}

/**
 * Build shadow polygons optimized for GPU rendering and uniform buffer access.
 *
 * This is the entry point for the texture-based shadow system. It produces
 * simplified polygon data that can be:
 * 1. Rasterized to a shadow texture (using vertices)
 * 2. Used for distance calculations in the shader (using silhouette points)
 *
 * @param silhouettePoints - All silhouette points for this wave direction
 * @param contours - Array of coastline contours
 * @param waveDir - Normalized wave direction in world space
 * @returns Array of render-ready shadow polygon data
 */
export function buildShadowPolygonsForRendering(
  silhouettePoints: SilhouettePoint[],
  contours: { contour: TerrainContour; contourIndex: number }[],
  waveDir: V2d,
): ShadowPolygonRenderData[] {
  const polygons: ShadowPolygonRenderData[] = [];

  // Group silhouette points by contour
  const pointsByContour = groupSilhouettePointsByContour(silhouettePoints);

  // Build contour lookup map
  const contourMap = new Map<number, TerrainContour>();
  for (const { contour, contourIndex } of contours) {
    contourMap.set(contourIndex, contour);
  }

  // For each contour, find the extremal silhouette points to create ONE shadow
  let polygonIndex = 0;
  for (const [contourIndex, points] of pointsByContour) {
    const contour = contourMap.get(contourIndex);
    if (!contour || points.length < 2) continue;

    // Find the leftmost and rightmost silhouette points perpendicular to wave direction
    let leftPoint: SilhouettePoint | null = null;
    let rightPoint: SilhouettePoint | null = null;
    let minRotatedX = Infinity;
    let maxRotatedX = -Infinity;

    for (const point of points) {
      const rotatedX =
        point.position.x * waveDir.y - point.position.y * waveDir.x;

      if (rotatedX < minRotatedX) {
        minRotatedX = rotatedX;
        leftPoint = point;
      }
      if (rotatedX > maxRotatedX) {
        maxRotatedX = rotatedX;
        rightPoint = point;
      }
    }

    if (!leftPoint || !rightPoint || leftPoint === rightPoint) continue;

    // Compute obstacle width (perpendicular span of the island)
    const obstacleWidth = maxRotatedX - minRotatedX;

    // Sample coastline points along the leeward arc (shadow-facing side)
    // coastlineVertices goes from rightPoint to leftPoint
    const coastlineVertices = sampleLeewardCoastlineArc(
      contour,
      rightPoint,
      leftPoint,
      waveDir,
    );

    // Build the complete polygon vertices for rasterization (CCW winding)
    // Order: rightSilhouette -> coastline (right to left) -> extendedLeft -> extendedRight
    const extendedLeft = leftPoint.position.add(
      waveDir.mul(SHADOW_EXTEND_DISTANCE),
    );
    const extendedRight = rightPoint.position.add(
      waveDir.mul(SHADOW_EXTEND_DISTANCE),
    );

    const vertices: V2d[] = [
      rightPoint.position,
      ...coastlineVertices.slice(1), // Skip first (same as rightPoint), include all to leftPoint
      extendedLeft,
      extendedRight,
    ];

    polygons.push({
      vertices,
      coastlineVertices,
      polygonIndex,
      leftSilhouette: leftPoint.position,
      rightSilhouette: rightPoint.position,
      obstacleWidth,
      contourIndex,
    });

    polygonIndex++;
  }

  return polygons;
}
