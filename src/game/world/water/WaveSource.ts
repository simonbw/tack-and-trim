/**
 * Wave source configuration types and utilities.
 *
 * Defines the data structures for configuring wave sources in level files,
 * and provides utilities for converting between file format and GPU data.
 */

/**
 * A single wave source configuration.
 * These values define a Gerstner wave component.
 */
export interface WaveSource {
  /** Wave amplitude in feet */
  amplitude: number;
  /** Wavelength in feet */
  wavelength: number;
  /** Wave direction in radians (0 = east, PI/2 = north) */
  direction: number;
  /** Phase offset in radians */
  phaseOffset: number;
  /** Speed multiplier (1.0 = natural wave speed) */
  speedMult: number;
  /** Distance to point source (use 1e10 for planar waves) */
  sourceDist: number;
  /** Point source X offset */
  sourceOffsetX: number;
  /** Point source Y offset */
  sourceOffsetY: number;
}

/**
 * Configuration for wave sources in a level.
 */
export interface WaveConfig {
  /** Array of wave source configurations */
  sources: WaveSource[];
}

/**
 * Default wave sources used when no level config is provided.
 * Matches the original WAVE_COMPONENTS from WaterConstants.ts.
 */
export const DEFAULT_WAVE_SOURCES: WaveSource[] = [
  // Single large swell - planar wave from the southwest (direction ~0.8 rad = ~45°)
  {
    amplitude: 0.4,
    wavelength: 200,
    direction: 0.8,
    phaseOffset: 0.0,
    speedMult: 1.0,
    sourceDist: 1e10,
    sourceOffsetX: 0,
    sourceOffsetY: 0,
  },
  // Single chop wave - follows wind direction
  {
    amplitude: 0.15,
    wavelength: 20,
    direction: 0.8,
    phaseOffset: 0.0,
    speedMult: 1.0,
    sourceDist: 1e10,
    sourceOffsetX: 0,
    sourceOffsetY: 0,
  },
];

/**
 * Default wave configuration.
 */
export const DEFAULT_WAVE_CONFIG: WaveConfig = {
  sources: DEFAULT_WAVE_SOURCES,
};

/**
 * Build wave data as a flat Float32Array for GPU uniform upload.
 * Each wave has 8 components matching the shader layout.
 *
 * @param sources - Array of wave sources to pack
 * @returns Float32Array with 8 floats per wave
 */
export function buildWaveDataFromSources(sources: WaveSource[]): Float32Array {
  const data = new Float32Array(sources.length * 8);
  for (let i = 0; i < sources.length; i++) {
    const wave = sources[i];
    data[i * 8 + 0] = wave.amplitude;
    data[i * 8 + 1] = wave.wavelength;
    data[i * 8 + 2] = wave.direction;
    data[i * 8 + 3] = wave.phaseOffset;
    data[i * 8 + 4] = wave.speedMult;
    data[i * 8 + 5] = wave.sourceDist;
    data[i * 8 + 6] = wave.sourceOffsetX;
    data[i * 8 + 7] = wave.sourceOffsetY;
  }
  return data;
}
