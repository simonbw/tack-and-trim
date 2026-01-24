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
  SWELL_WAVE_COUNT,
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
  /** Terrain influence: 0-1 factor for swell waves */
  swellEnergyFactor: number;
  /** Terrain influence: 0-1 factor for chop waves */
  chopEnergyFactor: number;
  /** Terrain influence: 0-1 factor based on fetch distance */
  fetchFactor: number;
  /** Angular offset for swell waves due to diffraction (radians) */
  swellDirectionOffset: number;
  /** Angular offset for chop waves due to diffraction (radians) */
  chopDirectionOffset: number;
  /** Terrain depth at query point (positive = land, negative = underwater) */
  depth: number;
}

// Shoaling constants
const DEEP_WATER_DEPTH = 50.0; // Reference deep water depth (ft)
const MIN_DEPTH = 2.0; // Minimum effective depth to prevent infinity

// Damping constants
const DEEP_THRESHOLD = 10.0; // No damping above this depth (ft)
const SHALLOW_THRESHOLD = 2.0; // Heavy damping below this depth (ft)
const MIN_DAMPING = 0.2; // Minimum damping factor in shallows

/**
 * Compute shoaling factor based on water depth.
 * Green's Law - waves grow taller as depth decreases.
 *
 * @param depth Terrain height (positive = land, negative = underwater)
 * @returns Shoaling factor (>1 in shallow water, 0 on land)
 */
function computeShoalingFactor(depth: number): number {
  // On land (positive depth), no waves
  if (depth >= 0) {
    return 0;
  }

  const effectiveDepth = Math.max(-depth, MIN_DEPTH);
  return Math.pow(DEEP_WATER_DEPTH / effectiveDepth, 0.25);
}

/**
 * Compute damping factor based on water depth.
 * Bottom friction attenuates waves in very shallow water.
 *
 * @param depth Terrain height (positive = land, negative = underwater)
 * @returns Damping factor (0-1, lower in shallow water)
 */
function computeDampingFactor(depth: number): number {
  // On land, no waves
  if (depth >= 0) {
    return 0;
  }

  const effectiveDepth = -depth;

  if (effectiveDepth >= DEEP_THRESHOLD) {
    return 1.0; // No damping in deep water
  }
  if (effectiveDepth <= SHALLOW_THRESHOLD) {
    return MIN_DAMPING; // Heavy damping in very shallow water
  }

  // Linear interpolation between shallow and deep thresholds
  return (
    MIN_DAMPING +
    ((1.0 - MIN_DAMPING) * (effectiveDepth - SHALLOW_THRESHOLD)) /
      (DEEP_THRESHOLD - SHALLOW_THRESHOLD)
  );
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
  const {
    time,
    waveAmpModNoise,
    surfaceNoise,
    swellEnergyFactor,
    chopEnergyFactor,
    fetchFactor,
    swellDirectionOffset,
    chopDirectionOffset,
  } = params;

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

  for (let i = 0; i < numWaves; i++) {
    const [
      amplitude,
      wavelength,
      baseDirection,
      phaseOffset,
      speedMult,
      sourceDist,
      sourceOffsetX,
      sourceOffsetY,
    ] = WAVE_COMPONENTS[i];

    // Apply direction offset from terrain diffraction
    const direction =
      baseDirection +
      (i < SWELL_WAVE_COUNT ? swellDirectionOffset : chopDirectionOffset);

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

  for (let i = 0; i < numWaves; i++) {
    const [
      baseAmplitude,
      wavelength,
      baseDirection,
      phaseOffset,
      speedMult,
      sourceDist,
      sourceOffsetX,
      sourceOffsetY,
    ] = WAVE_COMPONENTS[i];

    // Apply terrain influence based on wave type
    let amplitude: number;
    let direction: number;
    if (i < SWELL_WAVE_COUNT) {
      // Swell waves (0-4): apply swell energy factor and direction offset
      amplitude = baseAmplitude * swellEnergyFactor;
      direction = baseDirection + swellDirectionOffset;
    } else {
      // Chop waves (5-11): apply chop energy factor * fetch factor and direction offset
      amplitude = baseAmplitude * chopEnergyFactor * fetchFactor;
      direction = baseDirection + chopDirectionOffset;
    }

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

  // Surface turbulence disabled for testing
  // const smoothTurbulence =
  //   surfaceNoise(x * 0.15, y * 0.15, time * 0.5) * 0.03 +
  //   surfaceNoise(x * 0.4, y * 0.4, time * 0.8) * 0.01;
  // const timeCell = Math.floor(time * 0.5);
  // const whiteTurbulence = (hash2D(x * 0.5 + timeCell, y * 0.5) - 0.5) * 0.02;
  // height += smoothTurbulence + whiteTurbulence;

  // Apply shoaling and damping based on water depth
  const { depth } = params;
  const shoalingFactor = computeShoalingFactor(depth);
  const dampingFactor = computeDampingFactor(depth);
  const depthModifier = shoalingFactor * dampingFactor;

  height *= depthModifier;
  dhdt *= depthModifier;

  return { height, dhdt };
}
