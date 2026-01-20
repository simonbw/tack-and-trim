import { createNoise2D, NoiseFunction2D } from "simplex-noise";
import { V, V2d } from "../../../../core/Vector";
import { LandMass, TerrainDefinition } from "../LandMass";
import { SPLINE_SUBDIVISIONS } from "../TerrainConstants";

/**
 * CPU implementation of terrain height computation.
 * Used as fallback when GPU tiles aren't available.
 * Math must match GPU implementation exactly.
 */
export class TerrainComputeCPU {
  private hillNoise: NoiseFunction2D;

  constructor() {
    this.hillNoise = createNoise2D();
  }

  /**
   * Compute terrain height at a world point.
   * Returns 0 for points in water, positive for land.
   */
  computeHeightAtPoint(point: V2d, definition: TerrainDefinition): number {
    let maxHeight = 0;

    for (const landMass of definition.landMasses) {
      const signedDist = this.computeSignedDistance(point, landMass);

      if (signedDist < 0) {
        // Inside land mass
        const height = this.computeHeightProfile(point, signedDist, landMass);
        maxHeight = Math.max(maxHeight, height);
      }
    }

    return maxHeight;
  }

  /**
   * Compute signed distance to land mass boundary.
   * Negative = inside, Positive = outside (in water)
   */
  private computeSignedDistance(point: V2d, landMass: LandMass): number {
    const segments = this.subdivideSpline(landMass.controlPoints);
    return this.signedDistanceToPolyline(point, segments);
  }

  /**
   * Compute height based on distance from shore.
   */
  private computeHeightProfile(
    point: V2d,
    signedDist: number,
    landMass: LandMass,
  ): number {
    // signedDist is negative inside (distance from shore inward)
    const distInland = -signedDist;

    // Beach profile: smoothstep from 0 at shore to 1 at beachWidth
    const beachFactor = smoothstep(0, landMass.beachWidth, distInland);
    const baseHeight = beachFactor * landMass.peakHeight;

    // Rolling hills via noise
    const hillNoise = this.hillNoise(
      point.x * landMass.hillFrequency,
      point.y * landMass.hillFrequency,
    );
    const hillVariation = 1 + hillNoise * landMass.hillAmplitude;

    return baseHeight * hillVariation;
  }

  /**
   * Subdivide Catmull-Rom spline into line segments.
   * Closed loop - last point connects back to first.
   */
  private subdivideSpline(controlPoints: readonly V2d[]): V2d[] {
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
 * Smoothstep interpolation.
 * Returns 0 when x <= edge0, 1 when x >= edge1, smooth interpolation between.
 */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
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
