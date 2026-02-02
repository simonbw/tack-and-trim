/**
 * Type-safe uniform buffer definition for surface shader.
 *
 * Separated from SurfaceRenderer to avoid circular imports
 * with SurfaceShader.
 */

import {
  defineUniformStruct,
  f32,
  i32,
  mat3x3,
} from "../../core/graphics/UniformStruct";

// Type-safe uniform buffer definition - single source of truth for shader struct
export const SurfaceUniforms = defineUniformStruct("Uniforms", {
  // Camera matrix (mat3x3 = 48 bytes with padding)
  cameraMatrix: mat3x3,
  // Basic uniforms
  time: f32,
  screenWidth: f32,
  screenHeight: f32,
  _padding0: f32,
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  // Additional settings
  colorNoiseStrength: f32,
  hasTerrainData: i32,
  shallowThreshold: f32,
  // Texture dimensions
  waterTexWidth: f32,
  waterTexHeight: f32,
  terrainTexWidth: f32,
  terrainTexHeight: f32,
  wetnessTexWidth: f32,
  wetnessTexHeight: f32,
  _padding1: f32,
  _padding2: f32,
  // Wetness viewport
  wetnessViewportLeft: f32,
  wetnessViewportTop: f32,
  wetnessViewportWidth: f32,
  wetnessViewportHeight: f32,
});
