/**
 * Spline geometry utilities for validating terrain contours.
 *
 * Provides functions for:
 * - Detecting intersections between splines
 * - Detecting self-intersections within a spline
 * - Point-in-spline containment tests
 * - Spline-inside-spline containment tests
 */

import { V, V2d } from "../../../core/Vector";
import { catmullRomPoint, sampleClosedSpline } from "../../../core/util/Spline";
import { pointInPolygon } from "../../../core/util/Geometry";

// Re-export for consumers that were importing from here
export { sampleClosedSpline } from "../../../core/util/Spline";

/** Default number of samples per spline segment */
const DEFAULT_SAMPLES_PER_SEGMENT = 16;

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

/**
 * Validation result for a single contour.
 */
export interface ContourValidationResult {
  /** Whether the contour is valid */
  isValid: boolean;
  /** Self-intersections within this contour */
  selfIntersections: SplineIntersection[];
  /** Indices of other contours this one intersects with */
  intersectsWithContours: number[];
}

/**
 * Validate an array of contours, checking for self-intersections and
 * intersections between contours.
 *
 * @param contours - Array of contour control point arrays
 * @param samplesPerSegment - Sampling density (default 16)
 * @returns Array of validation results, one per contour
 */
export function validateContours(
  contours: readonly (readonly V2d[])[],
  samplesPerSegment: number = DEFAULT_SAMPLES_PER_SEGMENT,
): ContourValidationResult[] {
  const results: ContourValidationResult[] = contours.map(() => ({
    isValid: true,
    selfIntersections: [],
    intersectsWithContours: [],
  }));

  // Check each contour for self-intersection
  for (let i = 0; i < contours.length; i++) {
    const controlPoints = contours[i];
    if (controlPoints.length < 3) continue;

    const selfIntersections = checkSplineSelfIntersection(
      controlPoints,
      samplesPerSegment,
    );
    if (selfIntersections.length > 0) {
      results[i].isValid = false;
      results[i].selfIntersections = selfIntersections;
    }
  }

  // Check all pairs of contours for intersection
  for (let i = 0; i < contours.length; i++) {
    for (let j = i + 1; j < contours.length; j++) {
      const contourA = contours[i];
      const contourB = contours[j];

      if (contourA.length < 3 || contourB.length < 3) continue;

      const intersections = checkSplineIntersection(
        contourA,
        contourB,
        samplesPerSegment,
      );

      if (intersections.length > 0) {
        results[i].isValid = false;
        results[j].isValid = false;
        results[i].intersectsWithContours.push(j);
        results[j].intersectsWithContours.push(i);
      }
    }
  }

  return results;
}
