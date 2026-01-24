/**
 * Spline utilities for Catmull-Rom splines.
 *
 * Provides functions for:
 * - Evaluating Catmull-Rom spline points
 * - Sampling closed splines to point arrays
 * - Intersection detection between splines
 * - Point-in-spline and spline-in-spline containment
 */

import { V, V2d } from "../Vector";
import { pointInPolygon } from "./Geometry";

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

/**
 * Information about where two splines intersect.
 */
export interface SplineIntersection {
  /** World position of the intersection */
  point: V2d;
  /** Index of the control point segment on spline A (segment from point[i] to point[i+1]) */
  segmentA: number;
  /** Index of the control point segment on spline B */
  segmentB: number;
  /** Parameter along segment A (0-1) */
  tA: number;
  /** Parameter along segment B (0-1) */
  tB: number;
}

/**
 * A sampled point with metadata about which segment it came from.
 */
interface SampledPoint {
  point: V2d;
  /** Index of the control point segment this sample belongs to */
  segmentIndex: number;
  /** Parameter t within the segment (0-1) */
  t: number;
}

/**
 * Sample a closed spline with segment metadata for each point.
 */
function sampleClosedSplineWithMetadata(
  controlPoints: readonly V2d[],
  samplesPerSegment: number = DEFAULT_SAMPLES_PER_SEGMENT,
): SampledPoint[] {
  const n = controlPoints.length;
  if (n < 3) {
    return controlPoints.map((point, i) => ({
      point: V(point.x, point.y),
      segmentIndex: i,
      t: 0,
    }));
  }

  const result: SampledPoint[] = [];

  for (let i = 0; i < n; i++) {
    const p0 = controlPoints[(i - 1 + n) % n];
    const p1 = controlPoints[i];
    const p2 = controlPoints[(i + 1) % n];
    const p3 = controlPoints[(i + 2) % n];

    for (let j = 0; j < samplesPerSegment; j++) {
      const t = j / samplesPerSegment;
      result.push({
        point: catmullRomPoint(p0, p1, p2, p3, t),
        segmentIndex: i,
        t,
      });
    }
  }

  return result;
}

/**
 * Compute fraction along a line segment where a point lies.
 */
function fractionAlongSegment(start: V2d, end: V2d, point: V2d): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return 0;

  const px = point.x - start.x;
  const py = point.y - start.y;
  return (px * dx + py * dy) / lengthSq;
}

/**
 * Check if two splines intersect.
 *
 * @param splineA - Control points of the first spline
 * @param splineB - Control points of the second spline
 * @param samplesPerSegment - Sampling density (default 16)
 * @returns Array of intersection points with metadata
 */
export function checkSplineIntersection(
  splineA: readonly V2d[],
  splineB: readonly V2d[],
  samplesPerSegment: number = DEFAULT_SAMPLES_PER_SEGMENT,
): SplineIntersection[] {
  const samplesA = sampleClosedSplineWithMetadata(splineA, samplesPerSegment);
  const samplesB = sampleClosedSplineWithMetadata(splineB, samplesPerSegment);

  if (samplesA.length < 2 || samplesB.length < 2) {
    return [];
  }

  const intersections: SplineIntersection[] = [];

  // Check all pairs of line segments
  for (let i = 0; i < samplesA.length; i++) {
    const a1 = samplesA[i];
    const a2 = samplesA[(i + 1) % samplesA.length];

    for (let j = 0; j < samplesB.length; j++) {
      const b1 = samplesB[j];
      const b2 = samplesB[(j + 1) % samplesB.length];

      const intersection = V2d.lineSegmentsIntersection(
        a1.point,
        a2.point,
        b1.point,
        b2.point,
      );

      if (intersection) {
        // Compute the t values within the sampled segments
        const segmentTa =
          a1.t +
          (1 / samplesPerSegment) *
            fractionAlongSegment(a1.point, a2.point, intersection);
        const segmentTb =
          b1.t +
          (1 / samplesPerSegment) *
            fractionAlongSegment(b1.point, b2.point, intersection);

        intersections.push({
          point: intersection,
          segmentA: a1.segmentIndex,
          segmentB: b1.segmentIndex,
          tA: Math.min(1, Math.max(0, segmentTa)),
          tB: Math.min(1, Math.max(0, segmentTb)),
        });
      }
    }
  }

  return intersections;
}

/**
 * Check if a spline intersects itself.
 *
 * @param controlPoints - Control points defining the spline
 * @param samplesPerSegment - Sampling density (default 16)
 * @returns Array of self-intersection points with metadata
 */
export function checkSplineSelfIntersection(
  controlPoints: readonly V2d[],
  samplesPerSegment: number = DEFAULT_SAMPLES_PER_SEGMENT,
): SplineIntersection[] {
  const samples = sampleClosedSplineWithMetadata(
    controlPoints,
    samplesPerSegment,
  );

  if (samples.length < 4) {
    return [];
  }

  const intersections: SplineIntersection[] = [];
  const numControlPoints = controlPoints.length;

  // Check all pairs of line segments
  for (let i = 0; i < samples.length; i++) {
    const s1 = samples[i];
    const s2 = samples[(i + 1) % samples.length];

    // Start j at i+2 to skip adjacent segment
    for (let j = i + 2; j < samples.length; j++) {
      // Skip if this is the last segment wrapping back to the first
      // (they share an endpoint at the start/end of the loop)
      if (i === 0 && j === samples.length - 1) {
        continue;
      }

      const s3 = samples[j];
      const s4 = samples[(j + 1) % samples.length];

      // Skip segments from adjacent control point indices
      // (adjacent control point segments naturally share overlap in Catmull-Rom)
      const segDiff = Math.abs(s1.segmentIndex - s3.segmentIndex);
      const isAdjacent = segDiff <= 1 || segDiff === numControlPoints - 1;
      if (isAdjacent) {
        continue;
      }

      const intersection = V2d.lineSegmentsIntersection(
        s1.point,
        s2.point,
        s3.point,
        s4.point,
      );

      if (intersection) {
        const segmentTa =
          s1.t +
          (1 / samplesPerSegment) *
            fractionAlongSegment(s1.point, s2.point, intersection);
        const segmentTb =
          s3.t +
          (1 / samplesPerSegment) *
            fractionAlongSegment(s3.point, s4.point, intersection);

        intersections.push({
          point: intersection,
          segmentA: s1.segmentIndex,
          segmentB: s3.segmentIndex,
          tA: Math.min(1, Math.max(0, segmentTa)),
          tB: Math.min(1, Math.max(0, segmentTb)),
        });
      }
    }
  }

  return intersections;
}

/**
 * Check if a point is inside a closed spline using ray-casting.
 *
 * @param point - The point to test
 * @param controlPoints - Control points defining the spline
 * @param samplesPerSegment - Sampling density (default 16)
 * @returns True if the point is inside the spline
 */
export function isPointInsideSpline(
  point: V2d,
  controlPoints: readonly V2d[],
  samplesPerSegment: number = DEFAULT_SAMPLES_PER_SEGMENT,
): boolean {
  const polygon = sampleClosedSpline(controlPoints, samplesPerSegment);
  return pointInPolygon(point, polygon);
}

/**
 * Check if one spline is completely contained within another.
 *
 * @param inner - Control points of the potentially inner spline
 * @param outer - Control points of the potentially outer spline
 * @param samplesPerSegment - Sampling density (default 16)
 * @returns True if the inner spline is completely inside the outer spline
 */
export function isSplineInsideSpline(
  inner: readonly V2d[],
  outer: readonly V2d[],
  samplesPerSegment: number = DEFAULT_SAMPLES_PER_SEGMENT,
): boolean {
  // First check: no intersections between the splines
  const intersections = checkSplineIntersection(
    inner,
    outer,
    samplesPerSegment,
  );
  if (intersections.length > 0) {
    return false;
  }

  // Sample one point from the inner spline and check if it's inside the outer
  if (inner.length === 0) {
    return false;
  }

  // Use the first point of the sampled inner spline
  const innerSamples = sampleClosedSpline(inner, samplesPerSegment);
  if (innerSamples.length === 0) {
    return false;
  }

  return isPointInsideSpline(innerSamples[0], outer, samplesPerSegment);
}

/**
 * Compute the centroid of a spline by averaging sampled points.
 *
 * @param controlPoints - Control points defining the spline
 * @param samplesPerSegment - Sampling density (default 16)
 * @returns The centroid position
 */
export function computeSplineCentroid(
  controlPoints: readonly V2d[],
  samplesPerSegment: number = DEFAULT_SAMPLES_PER_SEGMENT,
): V2d {
  const samples = sampleClosedSpline(controlPoints, samplesPerSegment);

  if (samples.length === 0) {
    return V(0, 0);
  }

  let cx = 0,
    cy = 0;
  for (const p of samples) {
    cx += p.x;
    cy += p.y;
  }

  return V(cx / samples.length, cy / samples.length);
}
