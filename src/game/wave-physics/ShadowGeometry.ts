/**
 * Shadow Geometry
 *
 * Builds shadow regions from terrain contours. Each shadow region is defined by:
 * - Two boundary lines extending from silhouette points in the wave direction
 * - The coastline segment between those points (the "obstacle")
 * - The obstacle width (distance between silhouette points)
 *
 * Shadow polygon data is used for analytical Fresnel diffraction computation
 * in the water height and query shaders.
 */

import { V, V2d } from "../../core/Vector";
import { catmullRomPoint, sampleClosedSpline } from "../../core/util/Spline";
import type { TerrainContour } from "../world/terrain/LandMass";
import type { AABB } from "./CoastlineManager";
import {
  groupSilhouettePointsByContour,
  type SilhouettePoint,
} from "./SilhouetteComputation";
import { MAX_SHADOW_POLYGONS } from "./WavePhysicsManager";

/**
 * Shadow polygon data for analytical Fresnel diffraction.
 *
 * Contains the data needed for per-pixel wave shadow computation:
 * - Silhouette points define the shadow boundary lines
 * - Obstacle width is used for recovery distance calculation
 */
export interface ShadowPolygonRenderData {
  /** Polygon vertices in world space (for debug visualization) */
  vertices: V2d[];
  /** Coastline vertices from right to left silhouette (for debug visualization) */
  coastlineVertices: V2d[];
  /** Index of this polygon */
  polygonIndex: number;
  /** Left silhouette point (for Fresnel diffraction calculation) */
  leftSilhouette: V2d;
  /** Right silhouette point (for Fresnel diffraction calculation) */
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

/** Epsilon for floating point comparisons */
const EPSILON = 1e-6;

/** Minimum obstacle width to create a shadow (2 feet) */
const MIN_OBSTACLE_WIDTH = 2.0;

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
 * Shadow region - a contiguous run of shadow-casting edges.
 */
interface ShadowRegion {
  /** First shadow-casting vertex index */
  startIndex: number;
  /** Last shadow-casting vertex index */
  endIndex: number;
  /** Number of edges in this region */
  edgeCount: number;
}

/**
 * Classify each edge in a polygon as lit or shadow-casting based on wave direction.
 * An edge casts a shadow if its outward normal points in the wave direction.
 *
 * @param polygon - Closed polygon vertices (CCW winding)
 * @param waveDir - Normalized wave direction
 * @returns Boolean array where true = shadow-casting edge
 */
function classifyEdges(polygon: V2d[], waveDir: V2d): boolean[] {
  const result: boolean[] = [];

  for (let i = 0; i < polygon.length; i++) {
    const p1 = polygon[i];
    const p2 = polygon[(i + 1) % polygon.length];

    // Compute edge vector
    const edge = p2.sub(p1);

    // Compute outward normal (90° clockwise rotation for CCW polygon)
    const normal = V(edge.y, -edge.x);

    // Edge casts shadow if normal points with wave direction (away from wave source)
    const isShadowCasting = normal.dot(waveDir) > EPSILON;
    result.push(isShadowCasting);
  }

  return result;
}

/**
 * Find contiguous runs of shadow-casting edges in the edge classification array.
 *
 * @param isShadowEdge - Boolean array from classifyEdges()
 * @returns Array of shadow regions
 */
function findShadowRegions(isShadowEdge: boolean[]): ShadowRegion[] {
  if (isShadowEdge.length < 2) return [];

  const regions: ShadowRegion[] = [];
  let inRegion = false;
  let startIndex = -1;
  let edgeCount = 0;

  // First pass: find all regions not including wraparound
  for (let i = 0; i < isShadowEdge.length; i++) {
    if (isShadowEdge[i]) {
      if (!inRegion) {
        // Start new region
        startIndex = i;
        edgeCount = 1;
        inRegion = true;
      } else {
        // Continue region
        edgeCount++;
      }
    } else {
      if (inRegion) {
        // End region
        regions.push({
          startIndex,
          endIndex: i, // endIndex is the first vertex of the last edge
          edgeCount,
        });
        inRegion = false;
      }
    }
  }

  // Handle case where region extends to end of array
  if (inRegion) {
    // Check for wraparound - if first edge is also shadow-casting
    if (isShadowEdge[0]) {
      // Find where the region at the start ends
      let wrapEndIndex = 0;
      let wrapEdgeCount = 0;
      for (let i = 0; i < isShadowEdge.length; i++) {
        if (isShadowEdge[i]) {
          wrapEndIndex = i;
          wrapEdgeCount++;
        } else {
          break;
        }
      }

      // Merge wraparound region
      regions.push({
        startIndex,
        endIndex: wrapEndIndex,
        edgeCount: edgeCount + wrapEdgeCount,
      });
    } else {
      // No wraparound, just close the region
      regions.push({
        startIndex,
        endIndex: isShadowEdge.length - 1,
        edgeCount,
      });
    }
  } else if (isShadowEdge[0]) {
    // There's a region at the start that wasn't part of a wraparound
    // (this happens when there's a gap before the last region)
    let endIndex = 0;
    let edgeCount = 0;
    for (let i = 0; i < isShadowEdge.length; i++) {
      if (isShadowEdge[i]) {
        endIndex = i;
        edgeCount++;
      } else {
        break;
      }
    }
    regions.push({
      startIndex: 0,
      endIndex,
      edgeCount,
    });
  }

  return regions;
}

/**
 * Compute obstacle width for a shadow region.
 *
 * @param region - Shadow region
 * @param polygon - Polygon vertices
 * @param waveDir - Wave direction
 * @returns Obstacle width (perpendicular span)
 */
function computeRegionObstacleWidth(
  region: ShadowRegion,
  polygon: V2d[],
  waveDir: V2d,
): number {
  const leftSilhouette = polygon[region.endIndex];
  const rightSilhouette = polygon[region.startIndex];

  // Perpendicular axis (90° clockwise from wave)
  const perpRight = V(waveDir.y, -waveDir.x);

  const leftProj = leftSilhouette.dot(perpRight);
  const rightProj = rightSilhouette.dot(perpRight);

  return Math.abs(rightProj - leftProj);
}

/**
 * Resample vertices from a polygon between two indices to exactly targetCount points.
 *
 * @param polygon - Source polygon
 * @param startIndex - Start index (inclusive)
 * @param endIndex - End index (inclusive)
 * @param targetCount - Number of output points
 * @returns Resampled points
 */
function resampleArc(
  polygon: V2d[],
  startIndex: number,
  endIndex: number,
  targetCount: number,
): V2d[] {
  // Extract arc vertices (handle wraparound)
  const arcVertices: V2d[] = [];
  let idx = startIndex;
  while (true) {
    arcVertices.push(polygon[idx]);
    if (idx === endIndex) break;
    idx = (idx + 1) % polygon.length;
  }

  if (arcVertices.length <= 1) {
    // Degenerate arc
    return Array(targetCount).fill(arcVertices[0] || V(0, 0));
  }

  // Compute cumulative arc lengths
  const arcLengths = [0];
  for (let i = 1; i < arcVertices.length; i++) {
    const dist = arcVertices[i].sub(arcVertices[i - 1]).magnitude;
    arcLengths.push(arcLengths[i - 1] + dist);
  }

  const totalLength = arcLengths[arcLengths.length - 1];
  if (totalLength < EPSILON) {
    // Zero-length arc
    return Array(targetCount).fill(arcVertices[0]);
  }

  // Resample to targetCount points
  const result: V2d[] = [];
  for (let i = 0; i < targetCount; i++) {
    const fraction = i / (targetCount - 1);
    const targetLength = fraction * totalLength;

    // Find segment containing this length
    let segIdx = 0;
    for (let j = 1; j < arcLengths.length; j++) {
      if (arcLengths[j] >= targetLength) {
        segIdx = j - 1;
        break;
      }
    }

    // Interpolate within segment
    const segStart = arcLengths[segIdx];
    const segEnd = arcLengths[segIdx + 1];
    const segFraction =
      segEnd > segStart ? (targetLength - segStart) / (segEnd - segStart) : 0;

    const p1 = arcVertices[segIdx];
    const p2 = arcVertices[segIdx + 1];
    result.push(
      V(p1.x + (p2.x - p1.x) * segFraction, p1.y + (p2.y - p1.y) * segFraction),
    );
  }

  return result;
}

/**
 * Build a shadow polygon from a shadow region.
 *
 * @param region - Shadow region
 * @param polygon - Polygon vertices
 * @param waveDir - Wave direction
 * @param contourIndex - Source contour index
 * @param polygonIndex - Global polygon index
 * @returns Shadow polygon render data
 */
function buildShadowPolygonFromRegion(
  region: ShadowRegion,
  polygon: V2d[],
  waveDir: V2d,
  contourIndex: number,
  polygonIndex: number,
): ShadowPolygonRenderData {
  // Extract silhouette points (right = start, left = end by convention)
  const rightSilhouette = polygon[region.startIndex];
  const leftSilhouette = polygon[region.endIndex];

  // Resample coastline arc to exactly 32 points
  const coastlineVertices = resampleArc(
    polygon,
    region.startIndex,
    region.endIndex,
    COASTLINE_POLYGON_SAMPLES,
  );

  // Compute obstacle width
  const perpRight = V(waveDir.y, -waveDir.x);
  const leftProj = leftSilhouette.dot(perpRight);
  const rightProj = rightSilhouette.dot(perpRight);
  const obstacleWidth = Math.abs(rightProj - leftProj);

  // Build polygon vertices (CCW order)
  const extendedLeft = leftSilhouette.add(waveDir.mul(SHADOW_EXTEND_DISTANCE));
  const extendedRight = rightSilhouette.add(
    waveDir.mul(SHADOW_EXTEND_DISTANCE),
  );

  const vertices: V2d[] = [
    rightSilhouette,
    ...coastlineVertices.slice(1), // Skip first (same as rightSilhouette)
    extendedLeft,
    extendedRight,
  ];

  return {
    vertices,
    coastlineVertices,
    polygonIndex,
    leftSilhouette,
    rightSilhouette,
    obstacleWidth,
    contourIndex,
  };
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
 * Uses edge-normal classification to find multiple shadow regions per island.
 * Each contiguous run of shadow-casting edges creates a separate shadow polygon.
 *
 * @param silhouettePoints - DEPRECATED - no longer used
 * @param contours - Array of coastline contours
 * @param waveDir - Normalized wave direction in world space
 * @returns Array of render-ready shadow polygon data
 */
export function buildShadowPolygonsForRendering(
  silhouettePoints: SilhouettePoint[],
  contours: { contour: TerrainContour; contourIndex: number }[],
  waveDir: V2d,
): ShadowPolygonRenderData[] {
  const allPolygons: ShadowPolygonRenderData[] = [];

  for (const { contour, contourIndex } of contours) {
    // Sample contour to dense polygon
    const polygon = sampleClosedSpline(contour.controlPoints, 32);

    if (polygon.length < 3) continue;

    // Classify edges as lit or shadow-casting
    const isShadowEdge = classifyEdges(polygon, waveDir);

    // Find contiguous shadow regions
    const regions = findShadowRegions(isShadowEdge);

    if (regions.length === 0) continue;

    // Build shadow polygons, skipping tiny regions
    for (const region of regions) {
      // Check width before building polygon
      const width = computeRegionObstacleWidth(region, polygon, waveDir);
      if (width < MIN_OBSTACLE_WIDTH) continue;

      const shadowPolygon = buildShadowPolygonFromRegion(
        region,
        polygon,
        waveDir,
        contourIndex,
        allPolygons.length,
      );
      allPolygons.push(shadowPolygon);

      // Stop if we've hit the global limit
      if (allPolygons.length >= MAX_SHADOW_POLYGONS) break;
    }

    // Early exit if we've hit the limit
    if (allPolygons.length >= MAX_SHADOW_POLYGONS) break;
  }

  return allPolygons;
}
