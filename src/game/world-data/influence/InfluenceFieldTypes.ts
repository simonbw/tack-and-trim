/**
 * Shared types for the influence field system.
 *
 * Influence fields capture how terrain affects wind and waves. They are
 * pre-computed once at startup for each direction, then sampled at runtime
 * to determine local conditions.
 */

/**
 * Configuration for an influence field grid.
 */
export interface InfluenceGridConfig {
  /** Size of each grid cell in ft (e.g., 50-100 ft) */
  cellSize: number;

  /** Number of cells in X direction */
  cellsX: number;

  /** Number of cells in Y direction */
  cellsY: number;

  /** World X coordinate of the grid's minimum corner */
  originX: number;

  /** World Y coordinate of the grid's minimum corner */
  originY: number;

  /** Number of pre-computed source directions (e.g., 16 for 22.5° increments) */
  directionCount: number;
}

/**
 * Wind influence data for a single grid cell and direction.
 *
 * Describes how terrain modifies wind from a specific source direction
 * at this location.
 */
export interface WindInfluence {
  /**
   * Speed factor: 0.0 = fully blocked, 1.0 = unaffected, >1.0 = accelerated.
   * Wind in channels can accelerate to 1.5x or more.
   */
  speedFactor: number;

  /**
   * Direction offset in radians.
   * Positive = deflected counterclockwise, negative = clockwise.
   * Wind bends around large obstacles.
   */
  directionOffset: number;

  /**
   * Turbulence factor: 0.0 = smooth flow, 1.0 = highly turbulent.
   * Elevated in the wake/lee of obstacles.
   */
  turbulence: number;
}

/**
 * Swell influence data for a single grid cell, direction, and wavelength class.
 *
 * Describes how terrain affects swell propagation from a specific direction.
 */
export interface SwellInfluence {
  /**
   * Energy factor: 0.0 = fully blocked, 1.0 = full exposure.
   * Reduced in wave shadows, may be non-zero due to diffraction.
   */
  energyFactor: number;

  /**
   * Arrival direction in radians.
   * May differ from source direction due to diffraction around obstacles.
   * Waves can bend significantly through inlets and around headlands.
   */
  arrivalDirection: number;
}

/**
 * Default wind influence for open water (no terrain effect).
 */
export const DEFAULT_WIND_INFLUENCE: WindInfluence = {
  speedFactor: 1.0,
  directionOffset: 0,
  turbulence: 0,
};

/**
 * Default swell influence for open water (no terrain effect).
 * Uses 0 for arrival direction as a placeholder - should be set to source direction.
 */
export const DEFAULT_SWELL_INFLUENCE: SwellInfluence = {
  energyFactor: 1.0,
  arrivalDirection: 0,
};

/**
 * Wavelength class enumeration for swell propagation.
 *
 * Different wavelengths diffract differently:
 * - Long waves bend more around obstacles
 * - Short waves create sharper shadows
 */
export const enum WavelengthClass {
  /** Long swell (100m+ wavelength) - high diffraction */
  LongSwell = 0,
  /** Short chop (5-20m wavelength) - low diffraction */
  ShortChop = 1,
}

/** Number of wavelength classes */
export const WAVELENGTH_CLASS_COUNT = 2;

/**
 * Characteristic wavelengths in ft for each class.
 * Used for diffraction coefficient calculations.
 */
export const WAVELENGTH_CLASS_VALUES: Record<WavelengthClass, number> = {
  [WavelengthClass.LongSwell]: 400, // ~120m
  [WavelengthClass.ShortChop]: 50, // ~15m
};

/**
 * Create an empty wind influence grid cell array.
 * Initializes all cells to default (unaffected) values.
 */
export function createWindInfluenceArray(cellCount: number): WindInfluence[] {
  const result: WindInfluence[] = new Array(cellCount);
  for (let i = 0; i < cellCount; i++) {
    result[i] = { ...DEFAULT_WIND_INFLUENCE };
  }
  return result;
}

/**
 * Create an empty swell influence grid cell array.
 * Initializes all cells to default (unaffected) values.
 */
export function createSwellInfluenceArray(cellCount: number): SwellInfluence[] {
  const result: SwellInfluence[] = new Array(cellCount);
  for (let i = 0; i < cellCount; i++) {
    result[i] = { ...DEFAULT_SWELL_INFLUENCE };
  }
  return result;
}
