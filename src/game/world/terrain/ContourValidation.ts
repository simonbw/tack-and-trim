/**
 * Contour validation utilities for terrain editing.
 * Validates terrain contours for common issues like self-intersection.
 */

import type { V2d } from "../../../core/Vector";
import type { TerrainContour } from "./TerrainTypes";

/**
 * Represents an intersection point on a spline.
 */
export interface SplineIntersection {
  /** Parameter on first curve [0, 1] */
  t1: number;
  /** Parameter on second curve [0, 1] */
  t2: number;
  /** Intersection point in world space */
  point: V2d;
}

/**
 * Result of validating a terrain contour.
 */
export interface ContourValidationResult {
  /** Whether the contour is valid */
  isValid: boolean;
  /** Array of self-intersections found in this contour */
  selfIntersections: SplineIntersection[];
  /** Array of contour indices that this contour intersects with */
  intersectsWithContours: number[];
  /** Array of error messages (empty if valid) */
  errors?: string[];
  /** Array of warning messages */
  warnings?: string[];
}

/**
 * Validate a single terrain contour.
 *
 * TODO (Phase 2+): Implement proper spline self-intersection detection
 * Currently returns valid for all contours as a stub.
 */
export function validateContour(
  contour: TerrainContour,
): ContourValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Basic validation: minimum number of control points
  if (contour.controlPoints.length < 3) {
    errors.push("Contour must have at least 3 control points");
  }

  // TODO (Phase 2+): Implement checkSplineSelfIntersection() algorithm
  // For now, assume no self-intersections
  const selfIntersections: SplineIntersection[] = [];

  return {
    isValid: errors.length === 0,
    selfIntersections,
    intersectsWithContours: [],
    errors,
    warnings,
  };
}

/**
 * Validate multiple contours and check for inter-contour issues.
 *
 * TODO (Phase 2+): Implement proper contour-to-contour intersection detection
 * Currently returns valid for all contours as a stub.
 */
export function validateContours(
  contours: readonly (readonly V2d[])[],
): ContourValidationResult[] {
  // Convert V2d arrays to TerrainContour objects for validation
  return contours.map((controlPoints) =>
    validateContour({ controlPoints, height: 0 }),
  );
}
