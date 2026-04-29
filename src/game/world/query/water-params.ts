/**
 * Layout of the water channel's params SAB (Float32Array offsets).
 *
 * Writer: CpuWaterQueryManager (main thread).
 * Reader: query-worker water dispatch.
 *
 * Total inline size: 8 scalars + up to 8 wave sources × 8 floats = 72
 * floats. Fits inside PARAMS_FLOATS_PER_CHANNEL (128).
 */

export const WATER_PARAM_TIME = 0;
export const WATER_PARAM_TIDE_HEIGHT = 1;
export const WATER_PARAM_DEFAULT_DEPTH = 2;
export const WATER_PARAM_NUM_WAVES = 3;
export const WATER_PARAM_TIDAL_PHASE = 4;
export const WATER_PARAM_TIDAL_STRENGTH = 5;
export const WATER_PARAM_CONTOUR_COUNT = 6;
export const WATER_PARAM_MODIFIER_COUNT = 7;
export const WATER_PARAM_WAVE_AMPLITUDE_SCALE = 8;

/**
 * Wave source parameters inlined into the params SAB. 8 floats per wave:
 * [amplitude, wavelength, direction, phaseOffset, speedMult, sourceDist,
 *  sourceOffsetX, sourceOffsetY]. Must match `buildWaveDataFromSources`
 * in `WaveSource.ts`.
 */
export const WATER_PARAM_WAVE_SOURCES_BASE = 9;
export const WATER_PARAM_FLOATS_PER_WAVE = 8;
export const WATER_PARAM_MAX_WAVES = 8;

export const WATER_PARAM_COUNT =
  WATER_PARAM_WAVE_SOURCES_BASE +
  WATER_PARAM_MAX_WAVES * WATER_PARAM_FLOATS_PER_WAVE;
