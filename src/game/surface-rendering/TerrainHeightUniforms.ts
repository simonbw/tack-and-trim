/**
 * Uniform buffer definition for the Terrain Height compute shader.
 */

import {
  defineUniformStruct,
  f32,
  u32,
} from "../../core/graphics/UniformStruct";

/**
 * Uniforms for the terrain height compute pass.
 */
export const TerrainHeightUniforms = defineUniformStruct("Params", {
  // Screen dimensions (texture size)
  screenWidth: f32,
  screenHeight: f32,

  // Viewport bounds in world space
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,

  // Terrain params
  contourCount: u32,

  // Padding for 16-byte alignment
  _padding0: u32,
});
