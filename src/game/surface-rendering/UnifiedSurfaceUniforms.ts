/**
 * Type-safe uniform buffer definition for unified surface shader.
 *
 * Combines all parameters needed for the unified water + terrain rendering:
 * - Camera/screen transforms
 * - Viewport bounds
 * - Water wave parameters (time, tide, wave config)
 * - Terrain parameters (contour count, spline subdivisions)
 * - Shadow texture parameters
 */

import {
  defineUniformStruct,
  f32,
  i32,
  mat3x3,
  u32,
} from "../../core/graphics/UniformStruct";

// Type-safe uniform buffer definition - single source of truth for shader struct
export const UnifiedSurfaceUniforms = defineUniformStruct("Uniforms", {
  // Camera matrix (mat3x3 = 48 bytes with padding)
  cameraMatrix: mat3x3,

  // Screen/viewport - 16 bytes (4 floats)
  screenWidth: f32,
  screenHeight: f32,
  viewportLeft: f32,
  viewportTop: f32,

  // Viewport continued - 16 bytes (4 floats)
  viewportWidth: f32,
  viewportHeight: f32,
  time: f32,
  tideHeight: f32,

  // Water wave parameters - 16 bytes (4 values)
  numWaves: i32,
  swellWaveCount: i32,
  modifierCount: u32,
  waveSourceDirection: f32,

  // Terrain parameters - 16 bytes (4 values)
  contourCount: u32,
  splineSubdivisions: u32,
  defaultDepth: f32,
  shallowThreshold: f32,

  // Wave amplitude modulation - 16 bytes (4 floats)
  ampModSpatialScale: f32,
  ampModTimeScale: f32,
  ampModStrength: f32,
  gerstnerSteepness: f32,

  // Flags - 16 bytes (4 values)
  hasTerrainData: i32,
  _padding0: i32,
  _padding1: i32,
  _padding2: i32,
});
