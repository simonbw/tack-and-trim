/**
 * Shared constants for water simulation.
 * These are used by both TypeScript code and GLSL shaders (via interpolation).
 */

// Gerstner wave configuration
export const GERSTNER_STEEPNESS = 0.7;
export const GRAVITY_FT_PER_S2 = 9.8 * 3.28084; // gravity in ft/s²

// Amplitude modulation (wave grouping)
export const WAVE_AMP_MOD_SPATIAL_SCALE = 0.005;
export const WAVE_AMP_MOD_TIME_SCALE = 0.015;
export const WAVE_AMP_MOD_STRENGTH = 0; // Disabled for testing

// Maximum number of waves supported by shaders
// This is used as a loop bound in shaders that need to iterate over all waves
export const MAX_WAVES = 16;

// Representative wavelengths for terrain interaction (shoaling/damping)
export const SWELL_WAVELENGTH = 200; // ft
export const CHOP_WAVELENGTH = 30; // ft

// Fetch-based wave scaling (not currently used)
export const MIN_FETCH_FOR_WAVES = 100; // ft - minimum fetch to develop waves
export const FULL_FETCH_DISTANCE = 5000; // ft - fetch for fully developed waves

// Normalization scales for water data (world units to [0,1] range)
// Height: raw range ~[-2.5, 2.5] maps to [0, 1] via (height / 5.0 + 0.5)
export const WATER_HEIGHT_SCALE = 5.0;
// Velocity/dh/dt: raw range ~[-5, 5] maps to [0, 1] via (value / 10.0 + 0.5)
export const WATER_VELOCITY_SCALE = 10.0;

/**
 * GLSL code snippet defining wave constants.
 * Interpolate this into shaders that need wave parameters.
 * Note: NUM_WAVES is now a uniform, not a compile-time constant.
 */
export const WAVE_CONSTANTS_GLSL = /*glsl*/ `
const int MAX_WAVES = ${MAX_WAVES};
const float PI = 3.14159265359;
const float GERSTNER_STEEPNESS = ${GERSTNER_STEEPNESS};
const float GRAVITY = ${GRAVITY_FT_PER_S2};

// Amplitude modulation configuration
const float WAVE_AMP_MOD_SPATIAL_SCALE = ${WAVE_AMP_MOD_SPATIAL_SCALE};
const float WAVE_AMP_MOD_TIME_SCALE = ${WAVE_AMP_MOD_TIME_SCALE};
const float WAVE_AMP_MOD_STRENGTH = ${WAVE_AMP_MOD_STRENGTH};
`;
