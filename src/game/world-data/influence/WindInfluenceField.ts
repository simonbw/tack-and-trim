/**
 * Wrapper class for wind influence field storage.
 *
 * Provides a user-friendly API for sampling pre-computed wind influence data,
 * hiding the complexity of the underlying grid and interpolation.
 */

import { lerp } from "../../../core/util/MathUtil";
import { InfluenceFieldGrid } from "./InfluenceFieldGrid";
import type { InfluenceGridConfig, WindInfluence } from "./InfluenceFieldTypes";

/**
 * Interpolate between two angles, handling wraparound at ±π.
 * Result is in the range [-π, π].
 */
function lerpAngle(a: number, b: number, t: number): number {
  // Normalize difference to [-π, π]
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

/**
 * Interpolate between two WindInfluence values.
 */
function interpolateWindInfluence(
  a: WindInfluence,
  b: WindInfluence,
  t: number,
): WindInfluence {
  return {
    speedFactor: lerp(a.speedFactor, b.speedFactor, t),
    directionOffset: lerpAngle(a.directionOffset, b.directionOffset, t),
    turbulence: lerp(a.turbulence, b.turbulence, t),
  };
}

/**
 * Wind influence field storage.
 *
 * Stores pre-computed wind influence data from terrain propagation.
 * Provides interpolated sampling at any world position and wind direction.
 */
export class WindInfluenceField {
  private readonly grid: InfluenceFieldGrid<WindInfluence>;

  /**
   * Create a new wind influence field.
   *
   * @param grid - The underlying influence field grid from propagation
   */
  constructor(grid: InfluenceFieldGrid<WindInfluence>) {
    this.grid = grid;
  }

  /**
   * Get the grid configuration for bounds and resolution info.
   */
  get config(): InfluenceGridConfig {
    return this.grid.config;
  }

  /**
   * Sample wind influence at a world position for a given wind direction.
   *
   * Uses trilinear interpolation (bilinear in space, linear in direction)
   * to provide smooth results between grid cells and pre-computed directions.
   *
   * @param worldX - World X coordinate in ft
   * @param worldY - World Y coordinate in ft
   * @param windDirection - Wind source direction in radians
   * @returns Interpolated wind influence at this position
   */
  sample(worldX: number, worldY: number, windDirection: number): WindInfluence {
    return this.grid.sample(
      worldX,
      worldY,
      windDirection,
      interpolateWindInfluence,
    );
  }

  /**
   * Check if a world position is within the field bounds.
   *
   * @param worldX - World X coordinate in ft
   * @param worldY - World Y coordinate in ft
   */
  isInBounds(worldX: number, worldY: number): boolean {
    return this.grid.isInBounds(worldX, worldY);
  }

  /**
   * Get the world-space bounds of the field.
   */
  getWorldBounds(): { minX: number; maxX: number; minY: number; maxY: number } {
    return this.grid.getWorldBounds();
  }
}
