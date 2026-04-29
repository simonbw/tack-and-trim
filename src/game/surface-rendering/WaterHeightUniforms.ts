/**
 * Uniform buffer definition for the Water Height compute shader.
 */

import {
  defineUniformStruct,
  f32,
  mat3x3,
  u32,
} from "../../core/graphics/UniformStruct";

/**
 * Uniforms for the water height compute pass.
 */
export const WaterHeightUniforms = defineUniformStruct("Params", {
  // Clip-space → world transform for the output texture.
  // Same layout as TerrainScreenUniforms.texClipToWorld.
  texClipToWorld: mat3x3,

  // Dimensions of the output texture in texels.
  textureWidth: f32,
  textureHeight: f32,

  // Time and water params
  time: f32,
  tideHeight: f32,

  // Wave configuration (from level data)
  numWaves: u32,

  // Multiplier on Gerstner wave amplitude. 1.0 = no change. Driven from
  // `WeatherState.waveAmplitudeScale`.
  waveAmplitudeScale: f32,
});
