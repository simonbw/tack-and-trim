/**
 * Shared types for the influence field system.
 *
 * Influence fields capture how terrain affects wind. They are
 * pre-computed once at startup for each direction, then sampled at runtime
 * to determine local conditions.
 *
 * Note: Wave physics uses the analytical shadow-based system (WavePhysicsManager),
 * not grid-based propagation.
 */

/**
 * Configuration for a terrain depth grid.
 *
 * Used for land/water detection in propagation algorithms.
 * Values are terrain heights: positive = above water (land), negative = below water.
 */
export interface DepthGridConfig {
  /** World X coordinate of the grid's minimum corner */
  originX: number;

  /** World Y coordinate of the grid's minimum corner */
  originY: number;

  /** Size of each grid cell in ft */
  cellSize: number;

  /** Number of cells in X direction */
  cellsX: number;

  /** Number of cells in Y direction */
  cellsY: number;
}

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
 * Default wind influence for open water (no terrain effect).
 */
export const DEFAULT_WIND_INFLUENCE: WindInfluence = {
  speedFactor: 1.0,
  directionOffset: 0,
  turbulence: 0,
};
