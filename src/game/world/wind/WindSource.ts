/**
 * Wind source configuration types.
 *
 * Wind sources define directions for which terrain influence meshes
 * are precomputed. At runtime, each source has a weight (0-1) and
 * the shader blends all active sources' terrain influence values.
 */

/**
 * A single wind source — represents a wind direction for which
 * terrain influence has been precomputed.
 */
export interface WindSource {
  /** Wind direction in radians (direction wind blows toward) */
  direction: number;
}

/**
 * Configuration for wind sources in a level.
 */
export interface WindConfig {
  /** Array of wind source configurations */
  sources: WindSource[];
}

/**
 * Default wind sources used when no level config is provided.
 * Single NE source matching the default baseWind of V(11, 11).
 * atan2(11, 11) = PI/4.
 */
export const DEFAULT_WIND_SOURCES: WindSource[] = [{ direction: Math.PI / 4 }];

/**
 * Default wind configuration.
 */
export const DEFAULT_WIND_CONFIG: WindConfig = {
  sources: DEFAULT_WIND_SOURCES,
};
