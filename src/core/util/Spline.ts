/**
 * Spline utilities for Catmull-Rom splines.
 *
 * Provides functions for:
 * - Evaluating Catmull-Rom spline points
 * - Sampling closed splines to point arrays
 */

import { V, V2d } from "../Vector";

/**
 * Evaluate a Catmull-Rom spline point.
 *
 * @param p0 - Control point before segment start
 * @param p1 - Segment start point
 * @param p2 - Segment end point
 * @param p3 - Control point after segment end
 * @param t - Parameter along segment (0-1)
 * @returns Interpolated point on the spline
 */
export function catmullRomPoint(
  p0: V2d,
  p1: V2d,
  p2: V2d,
  p3: V2d,
  t: number,
): V2d {
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

/** Default number of samples per spline segment */
const DEFAULT_SAMPLES_PER_SEGMENT = 16;

/**
 * Sample a closed Catmull-Rom spline into a dense array of points.
 *
 * @param controlPoints - The control points defining the spline
 * @param samplesPerSegment - Number of samples per segment (default 16)
 * @returns Array of sampled points forming a polygon approximation
 */
export function sampleClosedSpline(
  controlPoints: readonly V2d[],
  samplesPerSegment: number = DEFAULT_SAMPLES_PER_SEGMENT,
): V2d[] {
  const n = controlPoints.length;
  if (n < 3) {
    // Not enough points for a proper spline, return as-is
    return [...controlPoints];
  }

  const result: V2d[] = [];

  for (let i = 0; i < n; i++) {
    const p0 = controlPoints[(i - 1 + n) % n];
    const p1 = controlPoints[i];
    const p2 = controlPoints[(i + 1) % n];
    const p3 = controlPoints[(i + 2) % n];

    // Sample this segment (don't include t=1 as it will be t=0 of next segment)
    for (let j = 0; j < samplesPerSegment; j++) {
      const t = j / samplesPerSegment;
      result.push(catmullRomPoint(p0, p1, p2, p3, t));
    }
  }

  return result;
}
