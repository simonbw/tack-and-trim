import { createNoise2D, NoiseFunction2D } from "simplex-noise";
import { V, V2d } from "../../../../core/Vector";
import { TerrainContour, TerrainDefinition } from "../LandMass";
import { DEFAULT_DEPTH, SPLINE_SUBDIVISIONS } from "../TerrainConstants";

/**
 * Cached contour with pre-computed polyline for efficient queries.
 */
interface CachedContour {
  contour: TerrainContour;
  polyline: V2d[];
}

/**
 * Floor/ceiling result for interpolation.
 */
interface FloorCeilingResult {
  floor: CachedContour | null;
  floorDist: number; // Signed distance to floor contour
  ceiling: CachedContour | null;
  ceilingDist: number; // Unsigned distance to ceiling contour
}

/**
 * CPU implementation of terrain height computation.
 * Uses floor/ceiling algorithm for contour-based terrain.
 *
 * Algorithm:
 * 1. Compute signed distance to all contours
 * 2. Floor = highest-height contour the point is INSIDE
 * 3. Ceiling = lowest-height contour the point is OUTSIDE with height > floor
 * 4. Interpolate between floor and ceiling based on distance ratio
 */
export class TerrainComputeCPU {
  private hillNoise: NoiseFunction2D;

  constructor() {
    this.hillNoise = createNoise2D();
  }

  /**
   * Compute terrain height at a world point.
   * Returns negative for underwater depths, positive for land heights.
   */
  computeHeightAtPoint(point: V2d, definition: TerrainDefinition): number {
    const defaultDepth = definition.defaultDepth ?? DEFAULT_DEPTH;

    // Sort contours by height (ascending) for floor/ceiling algorithm
    const sortedContours = this.getSortedCachedContours(definition);

    // Find floor and ceiling
    const result = this.findFloorCeiling(point, sortedContours);

    // Compute height based on floor/ceiling
    return this.computeHeightFromFloorCeiling(point, result, defaultDepth);
  }

  /**
   * Get contours sorted by height with pre-computed polylines.
   */
  private getSortedCachedContours(
    definition: TerrainDefinition,
  ): CachedContour[] {
    // Sort by height ascending
    const sorted = [...definition.contours].sort((a, b) => a.height - b.height);

    return sorted.map((contour) => ({
      contour,
      polyline: this.subdivideSpline(contour.controlPoints),
    }));
  }

  /**
   * Find the floor and ceiling contours for a point.
   * Floor = highest contour the point is inside
   * Ceiling = lowest contour the point is outside, with height > floor height
   */
  private findFloorCeiling(
    point: V2d,
    sortedContours: CachedContour[],
  ): FloorCeilingResult {
    let floor: CachedContour | null = null;
    let floorDist = 0;
    let ceiling: CachedContour | null = null;
    let ceilingDist = Infinity;

    // Contours are sorted by height ascending
    for (const cached of sortedContours) {
      const signedDist = this.signedDistanceToPolyline(point, cached.polyline);

      if (signedDist < 0) {
        // Point is inside this contour - it becomes the new floor
        // (since we iterate ascending, later floors override earlier ones)
        floor = cached;
        floorDist = signedDist;
      } else {
        // Point is outside this contour
        // It could be a ceiling candidate if its height > floor height
        const floorHeight = floor?.contour.height ?? -Infinity;
        if (cached.contour.height > floorHeight) {
          // This is a potential ceiling - track the nearest one
          if (signedDist < ceilingDist) {
            ceiling = cached;
            ceilingDist = signedDist;
          }
        }
      }
    }

    return { floor, floorDist, ceiling, ceilingDist };
  }

  /**
   * Compute height from floor/ceiling using interpolation.
   */
  private computeHeightFromFloorCeiling(
    point: V2d,
    result: FloorCeilingResult,
    defaultDepth: number,
  ): number {
    const { floor, floorDist, ceiling, ceilingDist } = result;

    // No floor - point is in deep ocean
    if (!floor) {
      // If there's a ceiling, transition from default depth toward it
      if (ceiling) {
        const transitionDist = 30; // Feet to transition from deep to shallow
        const t = Math.min(1, ceilingDist / transitionDist);
        // Smoothstep for gradual transition
        const smoothT = t * t * (3 - 2 * t);
        return (
          defaultDepth + (ceiling.contour.height - defaultDepth) * (1 - smoothT)
        );
      }
      return defaultDepth;
    }

    // Have a floor but no ceiling - point is at or above floor height
    if (!ceiling) {
      // Apply hill noise based on floor contour settings
      const noise = this.hillNoise(
        point.x * floor.contour.hillFrequency,
        point.y * floor.contour.hillFrequency,
      );
      const hillVariation = noise * floor.contour.hillAmplitude;
      return floor.contour.height + hillVariation;
    }

    // Have both floor and ceiling - interpolate between them
    const distInland = -floorDist; // Convert to positive distance inside floor
    const totalDist = distInland + ceilingDist;

    if (totalDist <= 0) {
      return floor.contour.height;
    }

    // Linear interpolation factor (0 at floor boundary, 1 at ceiling boundary)
    const t = distInland / totalDist;

    // Interpolate height
    const baseHeight =
      floor.contour.height +
      t * (ceiling.contour.height - floor.contour.height);

    // Apply hill noise using the ceiling's settings (since we're transitioning toward it)
    const noise = this.hillNoise(
      point.x * ceiling.contour.hillFrequency,
      point.y * ceiling.contour.hillFrequency,
    );
    const hillVariation = noise * ceiling.contour.hillAmplitude * t; // Scale noise by transition progress

    return baseHeight + hillVariation;
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
