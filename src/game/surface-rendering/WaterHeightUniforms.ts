/**
 * Uniform buffer definition for the Water Height compute shader.
 */

import {
  defineUniformStruct,
  f32,
  u32,
} from "../../core/graphics/UniformStruct";

/**
 * Uniforms for the water height compute pass.
 */
export const WaterHeightUniforms = defineUniformStruct("Params", {
  // Screen dimensions (texture size)
  screenWidth: f32,
  screenHeight: f32,

  // Viewport bounds in world space
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,

  // Time and water params
  time: f32,
  tideHeight: f32,
  _paddingMC: u32,

  // Wave configuration (from level data)
  numWaves: u32,

  // Padding for 16-byte alignment
  _padding0: u32,
  _padding1: u32,
  _padding2: u32,
  _padding3: u32,
});
