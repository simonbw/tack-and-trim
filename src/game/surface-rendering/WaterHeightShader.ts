/**
 * Water Height Compute Shader
 *
 * Computes water surface height at each pixel using Gerstner waves and modifiers.
 * Output is a single-channel r32float texture containing world-space water height.
 *
 * This is the first pass of the multi-pass surface rendering pipeline.
 */

import {
  ComputeShader,
  type ComputeShaderConfig,
} from "../../core/graphics/webgpu/ComputeShader";
import type { ShaderModule } from "../../core/graphics/webgpu/ShaderModule";
import {
  fn_calculateGerstnerWaves,
  struct_WaveModification,
} from "../world/shaders/gerstner-wave.wgsl";
import { fn_simplex3D } from "../world/shaders/noise.wgsl";
import { fn_calculateModifiers } from "../world/shaders/water-modifiers.wgsl";
import { fn_hash21 } from "../world/shaders/math.wgsl";
import {
  fn_computeShadowAttenuation,
  struct_ShadowData,
} from "../world/shaders/shadow-attenuation.wgsl";
import {
  GERSTNER_STEEPNESS,
  NUM_WAVES,
  SWELL_WAVE_COUNT,
  WAVE_AMP_MOD_SPATIAL_SCALE,
  WAVE_AMP_MOD_STRENGTH,
  WAVE_AMP_MOD_TIME_SCALE,
} from "../world/water/WaterConstants";
import {
  FLOATS_PER_MODIFIER,
  MAX_MODIFIERS,
} from "../world/water/WaterResources";

const WORKGROUP_SIZE = [8, 8] as const;

/**
 * Params module with uniforms and bindings for water height computation.
 */
const waterHeightParamsModule: ShaderModule = {
  dependencies: [struct_ShadowData],
  preamble: /*wgsl*/ `
// Water height computation parameters
struct Params {
  screenWidth: f32,
  screenHeight: f32,
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  time: f32,
  tideHeight: f32,
  waveSourceDirection: f32,
  modifierCount: u32,
  _padding0: u32,
  _padding1: u32,
}

// Wave computation constants
const NUM_WAVES: i32 = ${NUM_WAVES};
const SWELL_WAVE_COUNT: i32 = ${SWELL_WAVE_COUNT};
const GERSTNER_STEEPNESS: f32 = ${GERSTNER_STEEPNESS};
const WAVE_AMP_MOD_SPATIAL_SCALE: f32 = ${WAVE_AMP_MOD_SPATIAL_SCALE};
const WAVE_AMP_MOD_TIME_SCALE: f32 = ${WAVE_AMP_MOD_TIME_SCALE};
const WAVE_AMP_MOD_STRENGTH: f32 = ${WAVE_AMP_MOD_STRENGTH};

// Modifier constants
const MAX_MODIFIERS: u32 = ${MAX_MODIFIERS}u;
const FLOATS_PER_MODIFIER: u32 = ${FLOATS_PER_MODIFIER}u;
`,
  bindings: {
    params: { type: "uniform", wgslType: "Params" },
    waveData: { type: "storage", wgslType: "array<f32>" },
    modifiers: { type: "storage", wgslType: "array<f32>" },
    shadowData: { type: "storage", wgslType: "ShadowData" },
    shadowVertices: { type: "storage", wgslType: "array<vec2<f32>>" },
    outputTexture: { type: "storageTexture", format: "r32float" },
  },
  code: "",
};

/**
 * Main compute module for water height.
 */
const waterHeightComputeModule: ShaderModule = {
  dependencies: [
    waterHeightParamsModule,
    fn_hash21,
    fn_simplex3D,
    struct_WaveModification,
    fn_calculateGerstnerWaves,
    fn_calculateModifiers,
    fn_computeShadowAttenuation,
  ],
  code: /*wgsl*/ `
// Convert pixel coordinates to world position
fn pixelToWorld(pixel: vec2<u32>) -> vec2<f32> {
  let uv = vec2<f32>(
    f32(pixel.x) / params.screenWidth,
    f32(pixel.y) / params.screenHeight
  );
  return vec2<f32>(
    params.viewportLeft + uv.x * params.viewportWidth,
    params.viewportTop + uv.y * params.viewportHeight
  );
}

// Get wave modification from analytical shadow attenuation
fn getWaveModification(worldPos: vec2<f32>) -> vec2<f32> {
  // Compute shadow attenuation at this position
  let shadowAtten = computeShadowAttenuation(worldPos, &shadowData, &shadowVertices);

  // Return swell and chop energy factors
  return vec2<f32>(shadowAtten.swellEnergy, shadowAtten.chopEnergy);
}

// Calculate water height at a point
fn calculateWaterHeight(worldPos: vec2<f32>) -> f32 {
  // Get shadow attenuation for swell and chop
  let shadowEnergy = getWaveModification(worldPos);

  // Build wave modifications with shadow-attenuated energy
  var swellMod: WaveModification;
  swellMod.newDirection = vec2<f32>(cos(params.waveSourceDirection), sin(params.waveSourceDirection));
  swellMod.energyFactor = shadowEnergy.x;

  var chopMod: WaveModification;
  chopMod.newDirection = vec2<f32>(cos(params.waveSourceDirection), sin(params.waveSourceDirection));
  chopMod.energyFactor = shadowEnergy.y;

  // Sample amplitude modulation noise
  let ampModTime = params.time * WAVE_AMP_MOD_TIME_SCALE;
  let ampMod = 1.0 + simplex3D(vec3<f32>(
    worldPos.x * WAVE_AMP_MOD_SPATIAL_SCALE,
    worldPos.y * WAVE_AMP_MOD_SPATIAL_SCALE,
    ampModTime
  )) * WAVE_AMP_MOD_STRENGTH;

  // Calculate Gerstner waves with shadow-attenuated energy
  let waveResult = calculateGerstnerWaves(
    worldPos,
    params.time,
    &waveData,
    NUM_WAVES,
    SWELL_WAVE_COUNT,
    GERSTNER_STEEPNESS,
    swellMod,
    chopMod,
    ampMod,
    params.waveSourceDirection
  );

  // Calculate modifier contributions (wakes, etc.)
  let modifierResult = calculateModifiers(
    worldPos.x,
    worldPos.y,
    params.modifierCount,
    MAX_MODIFIERS,
    &modifiers,
    FLOATS_PER_MODIFIER
  );

  // Combined height = waves + modifiers + tide
  return waveResult.x + modifierResult.x + params.tideHeight;
}

@compute @workgroup_size(${WORKGROUP_SIZE[0]}, ${WORKGROUP_SIZE[1]})
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let pixel = global_id.xy;

  // Bounds check
  if (pixel.x >= u32(params.screenWidth) || pixel.y >= u32(params.screenHeight)) {
    return;
  }

  let worldPos = pixelToWorld(pixel);
  let height = calculateWaterHeight(worldPos);

  // Write to output texture
  textureStore(outputTexture, pixel, vec4<f32>(height, 0.0, 0.0, 0.0));
}
`,
};

const waterHeightShaderConfig: ComputeShaderConfig = {
  modules: [waterHeightComputeModule],
  workgroupSize: WORKGROUP_SIZE,
  label: "WaterHeightShader",
};

export function createWaterHeightShader(): ComputeShader {
  return new ComputeShader(waterHeightShaderConfig);
}
