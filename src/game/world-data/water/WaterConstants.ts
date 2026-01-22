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
export const WAVE_AMP_MOD_STRENGTH = 0.5;

// Wave components: [amplitude, wavelength, direction, phaseOffset, speedMult, sourceDist, sourceOffsetX, sourceOffsetY]
// Using 1e10 instead of Infinity for planar waves (GLSL compatible)
export const WAVE_COMPONENTS: readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
][] = [
  // Large ocean swells - planar (traveled thousands of miles)
  [0.25, 400, 0.1, 0.0, 1.0, 1e10, 0, 0],
  [0.18, 250, 1.7, 3.2, 0.98, 1e10, 0, 0],
  [0.12, 150, -0.5, 1.5, 1.02, 1e10, 0, 0],
  // Medium swells - very slight curvature
  [0.15, 80, 0.8, 4.8, 0.97, 8000, 500, -300],
  [0.12, 55, -1.2, 2.1, 1.03, 6000, -400, 600],
  // Wind waves - noticeable curvature, from nearby weather
  [0.18, 35, 1.5, 5.5, 0.99, 2000, 300, 200],
  [0.12, 22, -0.3, 0.9, 1.01, 1500, -500, -400],
  [0.08, 14, 2.2, 3.7, 0.96, 1200, 200, -300],
  // Chop - more curvature, local disturbances
  [0.04, 8, -1.5, 1.3, 1.05, 600, -150, 100],
  [0.025, 5, 0.5, 4.2, 0.94, 400, 100, -80],
  // Fine ripples - high curvature, very local
  [0.012, 3, 1.8, 2.6, 1.08, 200, -60, 40],
  [0.006, 2, -0.8, 5.9, 0.92, 150, 30, -50],
] as const;

export const NUM_WAVES = WAVE_COMPONENTS.length;

// Normalization scales for water data (world units to [0,1] range)
// Height: raw range ~[-2.5, 2.5] maps to [0, 1] via (height / 5.0 + 0.5)
export const WATER_HEIGHT_SCALE = 5.0;
// Velocity/dh/dt: raw range ~[-5, 5] maps to [0, 1] via (value / 10.0 + 0.5)
export const WATER_VELOCITY_SCALE = 10.0;

/**
 * Build wave data as a flat Float32Array for GPU uniform upload.
 * Each wave has 8 components.
 */
export function buildWaveDataArray(): Float32Array {
  const data = new Float32Array(NUM_WAVES * 8);
  for (let i = 0; i < NUM_WAVES; i++) {
    const wave = WAVE_COMPONENTS[i];
    data[i * 8 + 0] = wave[0]; // amplitude
    data[i * 8 + 1] = wave[1]; // wavelength
    data[i * 8 + 2] = wave[2]; // direction
    data[i * 8 + 3] = wave[3]; // phaseOffset
    data[i * 8 + 4] = wave[4]; // speedMult
    data[i * 8 + 5] = wave[5]; // sourceDist
    data[i * 8 + 6] = wave[6]; // sourceOffsetX
    data[i * 8 + 7] = wave[7]; // sourceOffsetY
  }
  return data;
}

/**
 * GLSL code snippet defining wave constants.
 * Interpolate this into shaders that need wave parameters.
 */
export const WAVE_CONSTANTS_GLSL = /*glsl*/ `
const int NUM_WAVES = ${NUM_WAVES};
const float PI = 3.14159265359;
const float GERSTNER_STEEPNESS = ${GERSTNER_STEEPNESS};
const float GRAVITY = ${GRAVITY_FT_PER_S2};

// Amplitude modulation configuration
const float WAVE_AMP_MOD_SPATIAL_SCALE = ${WAVE_AMP_MOD_SPATIAL_SCALE};
const float WAVE_AMP_MOD_TIME_SCALE = ${WAVE_AMP_MOD_TIME_SCALE};
const float WAVE_AMP_MOD_STRENGTH = ${WAVE_AMP_MOD_STRENGTH};
`;
