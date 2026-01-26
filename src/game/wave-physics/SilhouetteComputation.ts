/**
 * Silhouette Computation
 *
 * Finds silhouette points on coastline splines for a given wave direction.
 * Silhouette points are where the spline tangent is parallel to the wave direction,
 * i.e., where cross(tangent, waveDir) = 0.
 *
 * These points mark the edges of terrain from the wave's perspective and
 * define where shadow regions begin and end.
 */

import { V, V2d } from "../../core/Vector";
import { catmullRomPoint, catmullRomTangent } from "../../core/util/Spline";
import type { TerrainContour } from "../world-data/terrain/LandMass";

/**
 * A silhouette point on a coastline.
 */
export interface SilhouettePoint {
  /** World position of the silhouette point */
  position: V2d;
  /** Index of the coastline contour this point belongs to */
  contourIndex: number;
  /** Segment index within the contour (which control point pair) */
  segmentIndex: number;
  /** Parameter t within the segment (0-1) */
  t: number;
  /** Whether this is a shadow-casting edge (true) or shadow-ending edge (false) */
  isShadowCasting: boolean;
  /** Tangent vector at this point (normalized) */
  tangent: V2d;
  /** Normal vector pointing into the shadow region */
  shadowNormal: V2d;
}

/**
 * Compute silhouette points for a single coastline contour.
 *
 * @param contour - The coastline contour
 * @param contourIndex - Index of this contour in the terrain definition
 * @param waveDir - Normalized wave direction vector (direction waves are traveling)
 * @returns Array of silhouette points
 */
export function computeSilhouettePoints(
  contour: TerrainContour,
  contourIndex: number,
  waveDir: V2d,
): SilhouettePoint[] {
  const points = contour.controlPoints;
  const n = points.length;
  if (n < 3) return [];

  const silhouettePoints: SilhouettePoint[] = [];

  // For each spline segment
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];

    // Find t values where tangent(t) is parallel to waveDir.
    // Parallel means cross product = 0: tangent.x * waveDir.y - tangent.y * waveDir.x = 0
    //
    // The tangent is: 0.5 * (A + B*t + C*t²) where:
    //   A = -p0 + p2
    //   B = 2*(2*p0 - 5*p1 + 4*p2 - p3)
    //   C = 3*(-p0 + 3*p1 - 3*p2 + p3)
    //
    // So we solve: cross(A, waveDir) + cross(B, waveDir)*t + cross(C, waveDir)*t² = 0
    // where cross(v, w) = v.x * w.y - v.y * w.x

    const A = V(p2.x - p0.x, p2.y - p0.y);
    const B = V(
      2 * (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x),
      2 * (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y),
    );
    const C = V(
      3 * (-p0.x + 3 * p1.x - 3 * p2.x + p3.x),
      3 * (-p0.y + 3 * p1.y - 3 * p2.y + p3.y),
    );

    // 2D cross product: v × w = v.x * w.y - v.y * w.x
    const cross = (v: V2d) => v.x * waveDir.y - v.y * waveDir.x;

    const a = cross(C);
    const b = cross(B);
    const c = cross(A);

    // Solve quadratic at² + bt + c = 0
    const roots = solveQuadratic(a, b, c);

    for (const t of roots) {
      // Only consider roots in valid parameter range [0, 1)
      if (t < 0 || t >= 1) continue;

      // Compute the position and tangent at this point
      const position = catmullRomPoint(p0, p1, p2, p3, t);
      const tangent = catmullRomTangent(p0, p1, p2, p3, t);
      const tangentLen = tangent.magnitude;
      if (tangentLen < 1e-6) continue;

      const normalizedTangent = tangent.mul(1 / tangentLen);

      // Classify as shadow-casting or shadow-ending
      // Shadow-casting: coastline curves away from wave source (into shadow)
      // Shadow-ending: coastline curves toward wave source (out of shadow)
      //
      // This is determined by the sign of d/dt[cross(tangent, waveDir)] at this point
      // If positive: tangent is rotating counter-clockwise (left edge of shadow)
      // If negative: tangent is rotating clockwise (right edge of shadow)
      const tangentDerivative = computeTangentDerivative(p0, p1, p2, p3, t);
      const crossDerivative =
        tangentDerivative.x * waveDir.y - tangentDerivative.y * waveDir.x;
      const isShadowCasting = crossDerivative < 0;

      // Compute shadow normal (perpendicular to wave direction, pointing into shadow)
      // For shadow-casting edges, shadow is on the right side (relative to wave dir)
      // For shadow-ending edges, shadow is on the left side
      const perpRight = V(waveDir.y, -waveDir.x); // 90° clockwise
      const shadowNormal = isShadowCasting ? perpRight : perpRight.mul(-1);

      silhouettePoints.push({
        position,
        contourIndex,
        segmentIndex: i,
        t,
        isShadowCasting,
        tangent: normalizedTangent,
        shadowNormal,
      });
    }
  }

  return silhouettePoints;
}

/**
 * Compute all silhouette points for all coastlines.
 *
 * @param coastlines - Array of coastline contours with their indices
 * @param waveDir - Normalized wave direction vector
 * @returns Array of all silhouette points, sorted by contour index
 */
export function computeAllSilhouettePoints(
  coastlines: { contour: TerrainContour; contourIndex: number }[],
  waveDir: V2d,
): SilhouettePoint[] {
  const allPoints: SilhouettePoint[] = [];

  for (const { contour, contourIndex } of coastlines) {
    const points = computeSilhouettePoints(contour, contourIndex, waveDir);
    allPoints.push(...points);
  }

  return allPoints;
}

/**
 * Compute the second derivative of the tangent (curvature direction).
 * This is used to classify silhouette points as shadow-casting or shadow-ending.
 *
 * The tangent is: 0.5 * (A + B*t + C*t²)
 * The derivative is: 0.5 * (B + 2*C*t)
 */
function computeTangentDerivative(
  p0: V2d,
  p1: V2d,
  p2: V2d,
  p3: V2d,
  t: number,
): V2d {
  // B = 2*(2*p0 - 5*p1 + 4*p2 - p3)
  // C = 3*(-p0 + 3*p1 - 3*p2 + p3)
  // derivative = 0.5 * (B + 2*C*t)

  const Bx = 2 * (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x);
  const By = 2 * (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y);

  const Cx = 3 * (-p0.x + 3 * p1.x - 3 * p2.x + p3.x);
  const Cy = 3 * (-p0.y + 3 * p1.y - 3 * p2.y + p3.y);

  return V(0.5 * (Bx + 2 * Cx * t), 0.5 * (By + 2 * Cy * t));
}

/**
 * Solve a quadratic equation ax² + bx + c = 0.
 * Returns roots within numerical tolerance.
 */
function solveQuadratic(a: number, b: number, c: number): number[] {
  const EPSILON = 1e-10;

  // If a ≈ 0, it's linear: bx + c = 0
  if (Math.abs(a) < EPSILON) {
    if (Math.abs(b) < EPSILON) {
      // Constant equation, no roots (or infinite if c = 0)
      return [];
    }
    return [-c / b];
  }

  const discriminant = b * b - 4 * a * c;

  if (discriminant < -EPSILON) {
    // No real roots
    return [];
  }

  if (discriminant < EPSILON) {
    // One root (double root)
    return [-b / (2 * a)];
  }

  // Two roots
  const sqrtD = Math.sqrt(discriminant);
  return [(-b - sqrtD) / (2 * a), (-b + sqrtD) / (2 * a)];
}

/**
 * Group silhouette points by contour and order them along the contour perimeter.
 * This is useful for building shadow polygons.
 */
export function groupSilhouettePointsByContour(
  points: SilhouettePoint[],
): Map<number, SilhouettePoint[]> {
  const groups = new Map<number, SilhouettePoint[]>();

  for (const point of points) {
    let group = groups.get(point.contourIndex);
    if (!group) {
      group = [];
      groups.set(point.contourIndex, group);
    }
    group.push(point);
  }

  // Sort each group by position along the contour
  for (const group of groups.values()) {
    group.sort((a, b) => {
      if (a.segmentIndex !== b.segmentIndex) {
        return a.segmentIndex - b.segmentIndex;
      }
      return a.t - b.t;
    });
  }

  return groups;
}
