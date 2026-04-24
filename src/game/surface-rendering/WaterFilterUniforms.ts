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
import { SCENE_LIGHTING_FIELDS } from "../time/SceneLighting";

export const WaterFilterUniforms = defineUniformStruct("Params", {
  // Clip → world for the actual screen.
  cameraMatrix: mat3x3,

  // World → clip for the screen-space water height texture.
  worldToTexClip: mat3x3,

  screenWidth: f32,
  screenHeight: f32,

  // Device pixel ratio — fragPos.xy is in physical framebuffer pixels, but
  // the surface textures are sized at logical+margin resolution. Divide
  // fragPos.xy by this to get logical pixel coords before texel indexing.
  pixelRatio: f32,

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

  // Runtime-tunable water shader knobs. Populated each frame from
  // WaterTuning.ts via pushWaterTuning(); exposed in the TuningPanel
  // (toggle with backslash key) so the surface look can be tuned live.
  glitterAmpCalm: f32,
  glitterAmpWindy: f32,
  glitterTime: f32,
  glitterFreqParallel: f32,
  glitterFreqPerp: f32,
  glitterPeakWind: f32,
  glitterFalloff: f32,
  specularPowerCalm: f32,
  specularPowerWindy: f32,
  sunIntensity: f32,
  steepnessThresholdCalm: f32,
  steepnessThresholdWindy: f32,
  foamCellScale: f32,
  foamCoverageMax: f32,
  foamBandWidth: f32,
  foamEnable: f32,
  slickAmp: f32,
  slickWindHigh: f32,
  horizonBlend: f32,

  // Scene lighting (see SceneLighting.ts). Populated from TimeOfDay.
  ...SCENE_LIGHTING_FIELDS,
});
