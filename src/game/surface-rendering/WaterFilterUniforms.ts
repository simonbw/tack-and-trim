/**
 * Uniform buffer definition for the Water Filter shader.
 *
 * Applies wavelength-dependent Beer-Lambert absorption to the already-rendered
 * scene (boats + terrain) based on how far each pixel is below the water surface.
 */

import {
  defineUniformStruct,
  f32,
  i32,
  mat3x3,
} from "../../core/graphics/UniformStruct";

export const WaterFilterUniforms = defineUniformStruct("Params", {
  // Clip-to-world matrix (stored as 3 vec4s for alignment)
  cameraMatrix: mat3x3,

  screenWidth: f32,
  screenHeight: f32,

  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,

  time: f32,
  tideHeight: f32,
  hasTerrainData: i32,
});
