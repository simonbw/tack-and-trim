import { V, V2d } from "../../../../core/Vector";
import {
  buildContourTree,
  ContourTree,
  ContourTreeNode,
  TerrainContour,
  TerrainDefinition,
} from "../LandMass";
import { DEFAULT_DEPTH, SPLINE_SUBDIVISIONS } from "../TerrainConstants";

/**
 * Cached contour with pre-computed polyline for efficient queries.
 */
interface CachedContour {
  contour: TerrainContour;
  polyline: V2d[];
  treeNode: ContourTreeNode;
}

/**
 * Cached terrain data for efficient queries.
 */
interface CachedTerrain {
  sortedContours: CachedContour[];
  tree: ContourTree;
  defaultDepth: number;
}

/**
 * CPU implementation of terrain height computation.
 * Uses tree-based algorithm with inverse-distance weighting (IDW).
 *
 * Algorithm:
 * 1. Build containment tree from contours
 * 2. Find deepest contour containing the point
 * 3. If contour has children, use IDW blending based on distances to children
 * 4. If no children, return contour height directly
 */
export class TerrainComputeCPU {
  private cachedTerrain: CachedTerrain | null = null;
  private cachedDefinition: TerrainDefinition | null = null;

  /**
   * Compute terrain height at a world point.
   * Returns negative for underwater depths, positive for land heights.
   */
  computeHeightAtPoint(point: V2d, definition: TerrainDefinition): number {
    // Cache terrain data for efficiency
    const terrain = this.getCachedTerrain(definition);

    // Find deepest containing contour
    const containing = this.findDeepestContainingContour(
      point,
      terrain.sortedContours,
    );

    // Compute height using tree-based algorithm
    return this.computeHeightFromTree(point, containing, terrain);
  }

  /**
   * Get cached terrain data, rebuilding if definition changed.
   */
  private getCachedTerrain(definition: TerrainDefinition): CachedTerrain {
    if (this.cachedTerrain && this.cachedDefinition === definition) {
      return this.cachedTerrain;
    }

    // Sort by height ascending
    const sorted = [...definition.contours].sort((a, b) => a.height - b.height);
    const tree = buildContourTree(sorted);

    const sortedContours: CachedContour[] = sorted.map((contour, i) => ({
      contour,
      polyline: this.subdivideSpline(contour.controlPoints),
      treeNode: tree.nodes[i],
    }));

    this.cachedDefinition = definition;
    this.cachedTerrain = {
      sortedContours,
      tree,
      defaultDepth: definition.defaultDepth ?? DEFAULT_DEPTH,
    };

    return this.cachedTerrain;
  }

  /**
   * Find the deepest contour that contains the point.
   * Uses tree structure: start from roots, descend through children that contain the point.
   */
  private findDeepestContainingContour(
    point: V2d,
    sortedContours: CachedContour[],
  ): CachedContour | null {
    let deepest: CachedContour | null = null;

    // Check all contours - find the deepest one that contains the point
    for (const cached of sortedContours) {
      const signedDist = this.signedDistanceToPolyline(point, cached.polyline);
      if (signedDist < 0) {
        // Point is inside this contour
        if (!deepest || cached.treeNode.depth > deepest.treeNode.depth) {
          deepest = cached;
        }
      }
    }

    return deepest;
  }

  /**
   * Compute height using tree-based IDW algorithm.
   */
  private computeHeightFromTree(
    point: V2d,
    containing: CachedContour | null,
    terrain: CachedTerrain,
  ): number {
    // Not inside any contour - in the ocean
    if (!containing) {
      return this.computeOceanHeight(point, terrain);
    }

    const children = containing.treeNode.children;

    // No children - we're at a leaf, just return height + noise
    if (children.length === 0) {
      return this.computeLeafHeight(point, containing);
    }

    // Has children - use IDW blending
    return this.computeIDWHeight(point, containing, children, terrain);
  }

  /**
   * Compute height in the ocean (outside all contours).
   * Uses inverse-distance weighting between all root contours.
   */
  private computeOceanHeight(point: V2d, terrain: CachedTerrain): number {
    const minDist = 0.1; // Minimum distance to avoid division by zero

    let weightedSum = 0;
    let weightSum = 0;

    // Iterate over all root contours and use IDW
    for (const cached of terrain.sortedContours) {
      if (cached.treeNode.parentIndex === -1) {
        // This is a root contour
        const signedDist = this.signedDistanceToPolyline(
          point,
          cached.polyline,
        );
        // Only consider if we're outside (positive distance)
        if (signedDist >= 0) {
          const dist = Math.max(minDist, signedDist);
          const weight = 1 / dist;
          weightedSum += cached.contour.height * weight;
          weightSum += weight;
        }
      }
    }

    // If we have valid weights from root contours, use IDW result
    if (weightSum > 0) {
      return weightedSum / weightSum;
    }

    // Fallback to default depth if no root contours exist
    return terrain.defaultDepth;
  }

  /**
   * Compute height at a leaf contour (no children).
   */
  private computeLeafHeight(_point: V2d, contour: CachedContour): number {
    return contour.contour.height;
  }

  /**
   * Compute height using inverse-distance weighting from children.
   *
   * For each child:
   *   h_i = lerp(parent.height, child.height, smoothstep(dist))
   * Final = Σ(h_i / dist_i) / Σ(1 / dist_i)
   *
   * If far from all children, returns parent height.
   */
  private computeIDWHeight(
    point: V2d,
    parent: CachedContour,
    childIndices: number[],
    terrain: CachedTerrain,
  ): number {
    const minDist = 0.1; // Minimum distance to avoid division by zero
    const transitionDist = 30; // Distance for smoothstep transition

    let weightedSum = 0;
    let weightSum = 0;

    for (const childIdx of childIndices) {
      const child = terrain.sortedContours[childIdx];
      // Signed distance - negative means inside child
      const signedDist = this.signedDistanceToPolyline(point, child.polyline);

      // Use absolute distance for weighting
      const dist = Math.max(minDist, Math.abs(signedDist));

      // Smoothstep transition factor (0 = at parent boundary, 1 = at child boundary)
      const t = Math.max(0, 1 - dist / transitionDist);
      const smoothT = t * t * (3 - 2 * t);

      // Interpolated height for this child
      const h_i =
        parent.contour.height +
        smoothT * (child.contour.height - parent.contour.height);

      // IDW weight
      const weight = 1 / dist;
      weightedSum += h_i * weight;
      weightSum += weight;
    }

    // If we have valid weights, use IDW result
    if (weightSum > 0) {
      return weightedSum / weightSum;
    }

    // Fallback to leaf behavior
    return this.computeLeafHeight(point, parent);
  }

  /**
   * Compute signed distance from a point to a contour.
   * Used for batch queries where the polyline is cached externally.
   * Negative = inside, Positive = outside
   */
  computeSignedDistanceFromPolyline(point: V2d, polyline: V2d[]): number {
    return this.signedDistanceToPolyline(point, polyline);
  }

  /**
   * Subdivide Catmull-Rom spline into line segments.
   * Closed loop - last point connects back to first.
   */
  subdivideSpline(controlPoints: readonly V2d[]): V2d[] {
    const n = controlPoints.length;
    if (n < 2) return [...controlPoints];

    const segments: V2d[] = [];

    for (let i = 0; i < n; i++) {
      // For closed loop: wrap indices
      const p0 = controlPoints[(i - 1 + n) % n];
      const p1 = controlPoints[i];
      const p2 = controlPoints[(i + 1) % n];
      const p3 = controlPoints[(i + 2) % n];

      for (let j = 0; j < SPLINE_SUBDIVISIONS; j++) {
        const t = j / SPLINE_SUBDIVISIONS;
        segments.push(catmullRomPoint(p0, p1, p2, p3, t));
      }
    }

    return segments;
  }

  /**
   * Compute signed distance to closed polyline.
   * Negative = inside, Positive = outside
   * Uses winding number to determine inside/outside.
   */
  private signedDistanceToPolyline(point: V2d, vertices: V2d[]): number {
    let minDist = Infinity;
    let windingNumber = 0;

    const n = vertices.length;
    for (let i = 0; i < n; i++) {
      const a = vertices[i];
      const b = vertices[(i + 1) % n];

      // Distance to segment
      const dist = pointToSegmentDistance(point, a, b);
      minDist = Math.min(minDist, dist);

      // Winding number contribution
      windingNumber += windingContribution(point, a, b);
    }

    // Inside if winding number is non-zero
    const inside = windingNumber !== 0;
    return inside ? -minDist : minDist;
  }
}

/**
 * Evaluate Catmull-Rom spline at parameter t.
 * p0, p1, p2, p3 are control points, t in [0, 1] interpolates between p1 and p2.
 */
function catmullRomPoint(p0: V2d, p1: V2d, p2: V2d, p3: V2d, t: number): V2d {
  const t2 = t * t;
  const t3 = t2 * t;

  const x =
    0.5 *
    (2 * p1.x +
      (-p0.x + p2.x) * t +
      (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
      (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);

  const y =
    0.5 *
    (2 * p1.y +
      (-p0.y + p2.y) * t +
      (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
      (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);

  return V(x, y);
}

/**
 * Compute distance from point p to line segment a-b.
 */
function pointToSegmentDistance(p: V2d, a: V2d, b: V2d): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;

  if (lengthSq === 0) {
    return Math.hypot(p.x - a.x, p.y - a.y);
  }

  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));

  const nearestX = a.x + t * dx;
  const nearestY = a.y + t * dy;

  return Math.hypot(p.x - nearestX, p.y - nearestY);
}

/**
 * Compute winding number contribution for edge a-b.
 * Uses crossing number algorithm.
 */
function windingContribution(p: V2d, a: V2d, b: V2d): number {
  if (a.y <= p.y) {
    if (b.y > p.y) {
      // Upward crossing
      if (isLeft(a, b, p) > 0) return 1;
    }
  } else {
    if (b.y <= p.y) {
      // Downward crossing
      if (isLeft(a, b, p) < 0) return -1;
    }
  }
  return 0;
}

/**
 * Test if point p is left of line a-b.
 * Returns positive if left, negative if right, zero if on line.
 */
function isLeft(a: V2d, b: V2d, p: V2d): number {
  return (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
}
