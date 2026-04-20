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
  // Clip → world for the actual screen.
  cameraMatrix: mat3x3,

  // World → clip for the screen-space water height texture.
  worldToTexClip: mat3x3,

  screenWidth: f32,
  screenHeight: f32,

  time: f32,
  tideHeight: f32,
  hasTerrainData: i32,

  // Bio-optical water chemistry (per-level / per-region).
  // These drive the absorption/scattering calculation in the shader.
  // Typical ranges:
  //   chlorophyll: 0.01 (open ocean) – 10 (algal bloom), mg/m³
  //   cdom:        0.0  – 1.5 (tannic/coastal), normalized
  //   sediment:    0.0  – 3.0 (turbid estuary), normalized
  chlorophyll: f32,
  cdom: f32,
  sediment: f32,
});
