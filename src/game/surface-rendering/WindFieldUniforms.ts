/**
 * Uniform buffer definition for the Wind Field compute shader.
 */

import {
  defineUniformStruct,
  f32,
  mat3x3,
  u32,
} from "../../core/graphics/UniformStruct";

export const WindFieldUniforms = defineUniformStruct("Params", {
  texClipToWorld: mat3x3,

  textureWidth: u32,
  textureHeight: u32,

  time: f32,
  baseWindX: f32,
  baseWindY: f32,

  numActiveWindSources: u32,

  weights0: f32,
  weights1: f32,
  weights2: f32,
  weights3: f32,
  weights4: f32,
  weights5: f32,
  weights6: f32,
  weights7: f32,
});
