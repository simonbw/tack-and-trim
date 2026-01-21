/**
 * Wrapper class for swell influence field storage.
 *
 * Provides a user-friendly API for sampling pre-computed swell influence data,
 * managing both wavelength classes (long swell and short chop) as a single unit.
 */

import { lerp } from "../../../core/util/MathUtil";
import { InfluenceFieldGrid } from "./InfluenceFieldGrid";
import {
  type InfluenceGridConfig,
  type SwellInfluence,
  WavelengthClass,
} from "./InfluenceFieldTypes";

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
 * Interpolate between two SwellInfluence values.
 */
function interpolateSwellInfluence(
  a: SwellInfluence,
  b: SwellInfluence,
  t: number,
): SwellInfluence {
  return {
    energyFactor: lerp(a.energyFactor, b.energyFactor, t),
    arrivalDirection: lerpAngle(a.arrivalDirection, b.arrivalDirection, t),
  };
}

/**
 * Combined swell influence for both wavelength classes.
 */
export interface SwellInfluenceSample {
  longSwell: SwellInfluence;
  shortChop: SwellInfluence;
}

/**
 * Swell influence field storage.
 *
 * Stores pre-computed swell influence data for both wavelength classes:
 * - Long swell (100m+ wavelength) - high diffraction around obstacles
 * - Short chop (5-20m wavelength) - sharper wave shadows
 *
 * Both grids share the same spatial configuration but may have different
 * propagation characteristics.
 */
export class SwellInfluenceField {
  private readonly longSwellGrid: InfluenceFieldGrid<SwellInfluence>;
  private readonly shortChopGrid: InfluenceFieldGrid<SwellInfluence>;

  /**
   * Create a new swell influence field.
   *
   * @param longSwellGrid - Grid for long swell (high diffraction)
   * @param shortChopGrid - Grid for short chop (low diffraction)
   */
  constructor(
    longSwellGrid: InfluenceFieldGrid<SwellInfluence>,
    shortChopGrid: InfluenceFieldGrid<SwellInfluence>,
  ) {
    this.longSwellGrid = longSwellGrid;
    this.shortChopGrid = shortChopGrid;
  }

  /**
   * Get the grid configuration for bounds and resolution info.
   * Both grids share the same config.
   */
  get config(): InfluenceGridConfig {
    return this.longSwellGrid.config;
  }

  /**
   * Sample swell influence at a world position for a specific wavelength class.
   *
   * Uses trilinear interpolation (bilinear in space, linear in direction)
   * to provide smooth results between grid cells and pre-computed directions.
   *
   * @param worldX - World X coordinate in ft
   * @param worldY - World Y coordinate in ft
   * @param swellDirection - Swell source direction in radians
   * @param wavelengthClass - Which wavelength class to sample
   * @returns Interpolated swell influence at this position
   */
  sample(
    worldX: number,
    worldY: number,
    swellDirection: number,
    wavelengthClass: WavelengthClass,
  ): SwellInfluence {
    const grid =
      wavelengthClass === WavelengthClass.LongSwell
        ? this.longSwellGrid
        : this.shortChopGrid;

    return grid.sample(
      worldX,
      worldY,
      swellDirection,
      interpolateSwellInfluence,
    );
  }

  /**
   * Sample swell influence for both wavelength classes at once.
   *
   * More efficient than calling sample() twice when you need both values.
   *
   * @param worldX - World X coordinate in ft
   * @param worldY - World Y coordinate in ft
   * @param swellDirection - Swell source direction in radians
   * @returns Both long swell and short chop influence at this position
   */
  sampleAll(
    worldX: number,
    worldY: number,
    swellDirection: number,
  ): SwellInfluenceSample {
    return {
      longSwell: this.longSwellGrid.sample(
        worldX,
        worldY,
        swellDirection,
        interpolateSwellInfluence,
      ),
      shortChop: this.shortChopGrid.sample(
        worldX,
        worldY,
        swellDirection,
        interpolateSwellInfluence,
      ),
    };
  }

  /**
   * Check if a world position is within the field bounds.
   *
   * @param worldX - World X coordinate in ft
   * @param worldY - World Y coordinate in ft
   */
  isInBounds(worldX: number, worldY: number): boolean {
    return this.longSwellGrid.isInBounds(worldX, worldY);
  }

  /**
   * Get the world-space bounds of the field.
   */
  getWorldBounds(): { minX: number; maxX: number; minY: number; maxY: number } {
    return this.longSwellGrid.getWorldBounds();
  }
}
