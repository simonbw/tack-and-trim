/**
 * Configuration for propagation algorithms.
 *
 * These parameters control how wind and wave energy flows through the
 * terrain grid during pre-computation. Different physical phenomena
 * (wind vs swell) use different configurations to capture their
 * distinct behaviors.
 */

/**
 * Parameters controlling energy propagation through terrain.
 */
export interface PropagationConfig {
  /**
   * How much energy flows directly forward in the source direction.
   * Higher = more directional flow, sharper shadows.
   * Range: 0.0 to 1.0, typical: 0.6-0.8
   */
  directFlowFactor: number;

  /**
   * How much energy spreads laterally (perpendicular to flow).
   * Higher = more diffraction/spreading around obstacles.
   * Range: 0.0 to 0.5, typical: 0.1-0.3
   */
  lateralSpreadFactor: number;

  /**
   * Energy decay per grid cell traversed.
   * Lower = energy dissipates faster over distance.
   * Range: 0.9 to 1.0, typical: 0.97-0.99
   */
  decayFactor: number;

  /**
   * Maximum propagation iterations before stopping.
   * Should be enough for energy to cross the entire grid.
   * Typical: 100-500 depending on grid size.
   */
  maxIterations: number;

  /**
   * Convergence threshold for early termination.
   * Stop when max energy change per iteration drops below this.
   * Typical: 0.001-0.01
   */
  convergenceThreshold: number;
}

/**
 * Default configuration for wind propagation.
 *
 * Wind has moderate directional flow with limited spreading.
 * Creates sharp shadows behind large obstacles.
 */
export const WIND_PROPAGATION_CONFIG: PropagationConfig = {
  directFlowFactor: 0.8, // Strongly directional
  lateralSpreadFactor: 0.1, // Limited spreading
  decayFactor: 0.98, // 2% loss per cell
  maxIterations: 200,
  convergenceThreshold: 0.005,
};

/**
 * Configuration for long swell propagation.
 *
 * Long waves diffract significantly around obstacles.
 * Creates softer shadows, more energy penetrates into bays.
 */
export const LONG_SWELL_PROPAGATION_CONFIG: PropagationConfig = {
  directFlowFactor: 0.6, // Less directional
  lateralSpreadFactor: 0.3, // Significant spreading (diffraction)
  decayFactor: 0.985, // 1.5% loss per cell
  maxIterations: 200,
  convergenceThreshold: 0.005,
};

/**
 * Configuration for short chop propagation.
 *
 * Short waves diffract less than long waves.
 * Creates sharper shadows, less penetration into sheltered areas.
 */
export const SHORT_CHOP_PROPAGATION_CONFIG: PropagationConfig = {
  directFlowFactor: 0.75, // More directional than long swell
  lateralSpreadFactor: 0.15, // Less spreading
  decayFactor: 0.97, // 3% loss per cell
  maxIterations: 200,
  convergenceThreshold: 0.005,
};

/**
 * Grid resolution configuration for influence fields.
 */
export interface InfluenceFieldResolution {
  /** Cell size in ft (50-100 recommended for large-scale effects) */
  cellSize: number;

  /** Number of pre-computed directions (16 = 22.5° increments) */
  directionCount: number;
}

/**
 * Default resolution for wind influence fields.
 * NOTE: Using coarse resolution for fast iteration. Increase for production:
 * cellSize: 100, directionCount: 16
 */
export const WIND_FIELD_RESOLUTION: InfluenceFieldResolution = {
  cellSize: 50, // 50 ft cells (high quality)
  directionCount: 16, // 22.5° direction resolution
};

/**
 * Default resolution for swell influence fields.
 * NOTE: Using coarse resolution for fast iteration. Increase for production:
 * cellSize: 100, directionCount: 16
 */
export const SWELL_FIELD_RESOLUTION: InfluenceFieldResolution = {
  cellSize: 50, // 50 ft cells (high quality)
  directionCount: 16, // 22.5° direction resolution
};

/**
 * Default resolution for fetch map.
 * NOTE: Using coarse resolution for fast iteration. Increase for production:
 * cellSize: 200, directionCount: 16
 */
export const FETCH_FIELD_RESOLUTION: InfluenceFieldResolution = {
  cellSize: 100, // 100 ft cells (high quality)
  directionCount: 16, // 22.5° direction resolution
};

/**
 * Validate a propagation config.
 * Throws if any parameter is out of expected range.
 */
export function validatePropagationConfig(config: PropagationConfig): void {
  if (config.directFlowFactor < 0 || config.directFlowFactor > 1) {
    throw new Error(
      `directFlowFactor must be 0-1, got ${config.directFlowFactor}`,
    );
  }
  if (config.lateralSpreadFactor < 0 || config.lateralSpreadFactor > 0.5) {
    throw new Error(
      `lateralSpreadFactor must be 0-0.5, got ${config.lateralSpreadFactor}`,
    );
  }
  if (config.decayFactor < 0.9 || config.decayFactor > 1) {
    throw new Error(`decayFactor must be 0.9-1.0, got ${config.decayFactor}`);
  }
  if (config.maxIterations < 1 || config.maxIterations > 10000) {
    throw new Error(
      `maxIterations must be 1-10000, got ${config.maxIterations}`,
    );
  }
  if (config.convergenceThreshold < 0 || config.convergenceThreshold > 0.1) {
    throw new Error(
      `convergenceThreshold must be 0-0.1, got ${config.convergenceThreshold}`,
    );
  }
}

/**
 * Create a custom propagation config with overrides.
 *
 * @param base - Base config to start from
 * @param overrides - Parameters to override
 */
export function createPropagationConfig(
  base: PropagationConfig,
  overrides: Partial<PropagationConfig>,
): PropagationConfig {
  const config = { ...base, ...overrides };
  validatePropagationConfig(config);
  return config;
}
