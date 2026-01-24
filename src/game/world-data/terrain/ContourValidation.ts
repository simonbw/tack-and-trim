/**
 * Contour validation utilities for terrain editing.
 *
 * Provides functions for:
 * - Validating arrays of terrain contours for self-intersections
 * - Detecting intersections between contours
 */

import { V2d } from "../../../core/Vector";
import {
  checkSplineIntersection,
  checkSplineSelfIntersection,
  SplineIntersection,
} from "../../../core/util/Spline";

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

/** Default number of samples per spline segment */
const DEFAULT_SAMPLES_PER_SEGMENT = 16;

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
