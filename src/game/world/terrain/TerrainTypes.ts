/**
 * Core terrain types for the new world rendering system.
 * These types define the structure of terrain data used by both
 * the editor and the game's terrain system.
 */

import type { V2d } from "../../../core/Vector";

/**
 * A terrain contour defined by control points and height.
 * Contours form closed splines that define regions at specific heights.
 */
export interface TerrainContour {
  readonly controlPoints: readonly V2d[];
  readonly height: number;
}

/**
 * Complete terrain definition including all contours and default depth.
 */
export interface TerrainDefinition {
  readonly contours: readonly TerrainContour[];
  readonly defaultDepth: number;
}

/**
 * Create a terrain contour with the specified control points and height.
 * This is a simple factory function that ensures the correct structure.
 */
export function createContour(
  controlPoints: readonly V2d[],
  height: number,
): TerrainContour {
  return { controlPoints, height };
}
