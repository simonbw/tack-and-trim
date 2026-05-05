/**
 * Layout of the wind channel's params SAB (Float32Array offsets).
 *
 * Shared between the main thread (WindQueryManager writes params) and
 * the worker (query-worker reads them). Keep the offsets stable.
 *
 * The "fallback" fields are the values the kernel uses when the wind
 * mesh lookup misses — currently fixed at their neutral defaults
 * (speed factor 1, zero direction offset, zero turbulence) since the
 * mesh ships with neutral vertex attributes.
 */

export const WIND_PARAM_TIME = 0;
export const WIND_PARAM_BASE_X = 1;
export const WIND_PARAM_BASE_Y = 2;

/** Fallback when the mesh lookup misses. Neutral default: 1.0. */
export const WIND_PARAM_INFLUENCE_SPEED_FACTOR = 3;

/** Fallback when the mesh lookup misses. Neutral default: 0.0. */
export const WIND_PARAM_INFLUENCE_DIRECTION_OFFSET = 4;

/** Fallback when the mesh lookup misses. Neutral default: 0.0. */
export const WIND_PARAM_INFLUENCE_TURBULENCE = 5;

/**
 * Per-source weights for blending mesh lookups. Slots 0..7 (max 8 sources
 * — must match `MAX_WIND_SOURCES` in WindConstants.ts).
 */
export const WIND_PARAM_WEIGHTS_BASE = 6;
export const WIND_PARAM_WEIGHTS_COUNT = 8;

export const WIND_PARAM_COUNT =
  WIND_PARAM_WEIGHTS_BASE + WIND_PARAM_WEIGHTS_COUNT;
