/**
 * Data structures and packing utilities for GPU wind modifiers.
 *
 * Defines the data format for sail and turbulence modifiers that
 * are uploaded to the GPU for compute shader processing.
 */

import { MAX_SAILS, MAX_TURBULENCE } from "../WindConstants";

// Number of floats per modifier type
export const FLOATS_PER_SAIL = 16;
export const FLOATS_PER_TURBULENCE = 8;

/**
 * GPU-uploadable sail wind effect data.
 * Matches the shader struct layout (16 floats = 64 bytes).
 */
export interface GPUSailData {
  // Position and geometry (8 floats)
  centroidX: number;
  centroidY: number;
  chordDirX: number; // Normalized chord direction
  chordDirY: number;
  normalX: number; // Leeward-pointing normal
  normalY: number;
  chordLength: number;
  influenceRadius: number;

  // Aerodynamic state (4 floats)
  windDirX: number; // Base wind direction at sail
  windDirY: number;
  windSpeed: number;
  averageLiftCoefficient: number;

  // Effects (4 floats, with padding)
  stallFraction: number; // 0-1, controls wake shadow
}

/**
 * GPU-uploadable turbulence particle data.
 * Matches the shader struct layout (8 floats = 32 bytes).
 */
export interface GPUTurbulenceData {
  // Position (2 floats)
  positionX: number;
  positionY: number;

  // State (6 floats, with padding)
  radius: number;
  intensity: number; // 0-1, fades over lifetime
  seed: number; // For deterministic chaos
  age: number; // For time-varying chaos
}

/**
 * Pack sail data into a Float32Array at the given offset.
 */
export function packSailData(
  sail: GPUSailData,
  buffer: Float32Array,
  offset: number,
): void {
  buffer[offset + 0] = sail.centroidX;
  buffer[offset + 1] = sail.centroidY;
  buffer[offset + 2] = sail.chordDirX;
  buffer[offset + 3] = sail.chordDirY;
  buffer[offset + 4] = sail.normalX;
  buffer[offset + 5] = sail.normalY;
  buffer[offset + 6] = sail.chordLength;
  buffer[offset + 7] = sail.influenceRadius;
  buffer[offset + 8] = sail.windDirX;
  buffer[offset + 9] = sail.windDirY;
  buffer[offset + 10] = sail.windSpeed;
  buffer[offset + 11] = sail.averageLiftCoefficient;
  buffer[offset + 12] = sail.stallFraction;
  buffer[offset + 13] = 0; // padding
  buffer[offset + 14] = 0; // padding
  buffer[offset + 15] = 0; // padding
}

/**
 * Pack turbulence data into a Float32Array at the given offset.
 */
export function packTurbulenceData(
  turb: GPUTurbulenceData,
  buffer: Float32Array,
  offset: number,
): void {
  buffer[offset + 0] = turb.positionX;
  buffer[offset + 1] = turb.positionY;
  buffer[offset + 2] = turb.radius;
  buffer[offset + 3] = turb.intensity;
  buffer[offset + 4] = turb.seed;
  buffer[offset + 5] = turb.age;
  buffer[offset + 6] = 0; // padding
  buffer[offset + 7] = 0; // padding
}

/**
 * Create a pre-allocated buffer for sail data.
 */
export function createSailDataBuffer(): Float32Array {
  return new Float32Array(MAX_SAILS * FLOATS_PER_SAIL);
}

/**
 * Create a pre-allocated buffer for turbulence data.
 */
export function createTurbulenceDataBuffer(): Float32Array {
  return new Float32Array(MAX_TURBULENCE * FLOATS_PER_TURBULENCE);
}
