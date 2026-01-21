/**
 * Wrapper class for fetch distance map storage.
 *
 * Provides a user-friendly API for sampling pre-computed fetch distances,
 * which represent how far wind can blow across open water before reaching
 * a given point.
 */

import { lerp } from "../../../core/util/MathUtil";
import { InfluenceFieldGrid } from "./InfluenceFieldGrid";
import type { InfluenceGridConfig } from "./InfluenceFieldTypes";

/**
 * Interpolate between two fetch distance values.
 */
function interpolateFetch(a: number, b: number, t: number): number {
  return lerp(a, b, t);
}

/**
 * Fetch distance map storage.
 *
 * Stores pre-computed fetch distances for each grid cell and wind direction.
 * Fetch is the distance wind has traveled over open water, which affects
 * wave development - longer fetch produces larger waves.
 */
export class FetchMap {
  private readonly grid: InfluenceFieldGrid<number>;

  /**
   * Create a new fetch map.
   *
   * @param grid - The underlying grid from fetch computation
   */
  constructor(grid: InfluenceFieldGrid<number>) {
    this.grid = grid;
  }

  /**
   * Get the grid configuration for bounds and resolution info.
   */
  get config(): InfluenceGridConfig {
    return this.grid.config;
  }

  /**
   * Sample fetch distance at a world position for a given wind direction.
   *
   * Uses trilinear interpolation (bilinear in space, linear in direction)
   * to provide smooth results between grid cells and pre-computed directions.
   *
   * @param worldX - World X coordinate in ft
   * @param worldY - World Y coordinate in ft
   * @param windDirection - Wind source direction in radians
   * @returns Interpolated fetch distance in ft
   */
  sample(worldX: number, worldY: number, windDirection: number): number {
    return this.grid.sample(worldX, worldY, windDirection, interpolateFetch);
  }

  /**
   * Check if a world position is within the map bounds.
   *
   * @param worldX - World X coordinate in ft
   * @param worldY - World Y coordinate in ft
   */
  isInBounds(worldX: number, worldY: number): boolean {
    return this.grid.isInBounds(worldX, worldY);
  }

  /**
   * Get the world-space bounds of the map.
   */
  getWorldBounds(): { minX: number; maxX: number; minY: number; maxY: number } {
    return this.grid.getWorldBounds();
  }
}
