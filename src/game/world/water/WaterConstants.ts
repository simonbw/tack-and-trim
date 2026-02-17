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

// Normalization scales for water data (world units to [0,1] range)
// Height: raw range ~[-2.5, 2.5] maps to [0, 1] via (height / 5.0 + 0.5)
export const WATER_HEIGHT_SCALE = 5.0;
