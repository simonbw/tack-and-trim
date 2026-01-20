/**
 * Pure CPU Gerstner wave computation.
 *
 * Extracted from WaterInfo to enable hybrid GPU/CPU computation:
 * - GPU readback provides wave data for most queries (in-viewport)
 * - This module provides fallback for out-of-viewport queries
 *
 * The math here matches the GPU shader exactly for consistency.
 */

import { NoiseFunction3D } from "simplex-noise";
import {
  GERSTNER_STEEPNESS,
  GRAVITY_FT_PER_S2,
  WAVE_AMP_MOD_SPATIAL_SCALE,
  WAVE_AMP_MOD_STRENGTH,
  WAVE_AMP_MOD_TIME_SCALE,
  WAVE_COMPONENTS,
} from "../WaterConstants";

/**
 * Wave data at a specific point.
 */
export interface WaveData {
  /** Surface displacement in ft */
  height: number;
  /** Rate of height change in ft/s */
  dhdt: number;
}

/**
 * Parameters for CPU wave computation.
 */
export interface WaterComputeParams {
  /** Current game time in seconds */
  time: number;
  /** Noise function for wave amplitude modulation */
  waveAmpModNoise: NoiseFunction3D;
  /** Noise function for surface turbulence */
  surfaceNoise: NoiseFunction3D;
}

/**
 * Simple hash function for white noise - returns value in range [0, 1]
 * Uses the fractional part of a large sine product.
 * Matches GPU shader implementation.
 */
function hash2D(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

/**
 * Compute wave data (height and dh/dt) at a world position using Gerstner waves.
 *
 * This function implements the full two-pass Gerstner algorithm:
 * 1. First pass computes horizontal displacement
 * 2. Second pass computes height and dh/dt at the displaced position
 *
 * The math matches the GPU compute shader exactly.
 *
 * @param x World X coordinate in ft
 * @param y World Y coordinate in ft
 * @param params Computation parameters (time, noise functions)
 * @returns Wave data with height and rate of change
 */
export function computeWaveDataAtPoint(
  x: number,
  y: number,
  params: WaterComputeParams,
): WaveData {
  const { time, waveAmpModNoise, surfaceNoise } = params;

  // Sample amplitude modulation noise once per point (slow-changing)
  const ampModTime = time * WAVE_AMP_MOD_TIME_SCALE;
  const ampMod =
    1 +
    waveAmpModNoise(
      x * WAVE_AMP_MOD_SPATIAL_SCALE,
      y * WAVE_AMP_MOD_SPATIAL_SCALE,
      ampModTime,
    ) *
      WAVE_AMP_MOD_STRENGTH;

  // First pass: compute Gerstner horizontal displacement
  let dispX = 0;
  let dispY = 0;
  const numWaves = WAVE_COMPONENTS.length;

  for (const [
    amplitude,
    wavelength,
    direction,
    phaseOffset,
    speedMult,
    sourceDist,
    sourceOffsetX,
    sourceOffsetY,
  ] of WAVE_COMPONENTS) {
    const baseDx = Math.cos(direction);
    const baseDy = Math.sin(direction);
    const k = (2 * Math.PI) / wavelength;
    const omega = Math.sqrt(GRAVITY_FT_PER_S2 * k) * speedMult;

    let dx: number, dy: number, phase: number;

    // sourceDist > 1e9 means planar wave (using 1e10 instead of Infinity for GLSL compat)
    if (sourceDist > 1e9) {
      // Planar wave - original calculation
      dx = baseDx;
      dy = baseDy;
      const projected = x * dx + y * dy;
      phase = k * projected - omega * time + phaseOffset;
    } else {
      // Point source wave - curved wavefronts
      // Source is behind the wave direction, with optional offset
      const sourceX = -baseDx * sourceDist + sourceOffsetX;
      const sourceY = -baseDy * sourceDist + sourceOffsetY;

      const toPointX = x - sourceX;
      const toPointY = y - sourceY;
      const distFromSource = Math.sqrt(
        toPointX * toPointX + toPointY * toPointY,
      );

      // Local wave direction is radial from source
      dx = toPointX / distFromSource;
      dy = toPointY / distFromSource;
      phase = k * distFromSource - omega * time + phaseOffset;
    }

    // Gerstner horizontal displacement
    const Q = GERSTNER_STEEPNESS / (k * amplitude * numWaves);
    const cosPhase = Math.cos(phase);
    dispX += Q * amplitude * dx * cosPhase;
    dispY += Q * amplitude * dy * cosPhase;
  }

  // Second pass: compute height and dh/dt at displaced position
  const sampleX = x - dispX;
  const sampleY = y - dispY;
  let height = 0;
  let dhdt = 0;

  for (const [
    amplitude,
    wavelength,
    direction,
    phaseOffset,
    speedMult,
    sourceDist,
    sourceOffsetX,
    sourceOffsetY,
  ] of WAVE_COMPONENTS) {
    const baseDx = Math.cos(direction);
    const baseDy = Math.sin(direction);
    const k = (2 * Math.PI) / wavelength;
    const omega = Math.sqrt(GRAVITY_FT_PER_S2 * k) * speedMult;

    let phase: number;

    if (sourceDist > 1e9) {
      // Planar wave
      const projected = sampleX * baseDx + sampleY * baseDy;
      phase = k * projected - omega * time + phaseOffset;
    } else {
      // Point source wave
      const sourceX = -baseDx * sourceDist + sourceOffsetX;
      const sourceY = -baseDy * sourceDist + sourceOffsetY;

      const toPointX = sampleX - sourceX;
      const toPointY = sampleY - sourceY;
      const distFromSource = Math.sqrt(
        toPointX * toPointX + toPointY * toPointY,
      );

      phase = k * distFromSource - omega * time + phaseOffset;
    }

    const sinPhase = Math.sin(phase);
    const cosPhase = Math.cos(phase);

    height += amplitude * ampMod * sinPhase;

    // dh/dt = d/dt[A * ampMod * sin(k*d - omega*t + phi)]
    //       = A * ampMod * cos(phase) * (-omega)
    //       = -A * ampMod * omega * cos(phase)
    dhdt += -amplitude * ampMod * omega * cosPhase;
  }

  // Add surface turbulence - small non-periodic noise that breaks up the grid
  // This represents chaotic micro-variations not captured by the wave model
  // Mix of smooth noise (for organic feel) and white noise (for randomness)
  const smoothTurbulence =
    surfaceNoise(x * 0.15, y * 0.15, time * 0.5) * 0.03 +
    surfaceNoise(x * 0.4, y * 0.4, time * 0.8) * 0.01;

  // White noise - changes per pixel, animated slowly with time
  // Use floor(t) to change the noise pattern roughly once per second
  const timeCell = Math.floor(time * 0.5);
  const whiteTurbulence = (hash2D(x * 0.5 + timeCell, y * 0.5) - 0.5) * 0.02;

  height += smoothTurbulence + whiteTurbulence;
  // Note: turbulence contribution to dhdt is negligible and non-physical, so we skip it

  return { height, dhdt };
}
