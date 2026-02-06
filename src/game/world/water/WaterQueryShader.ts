/**
 * Water Query Compute Shader
 *
 * Samples water data (height, velocity, normals, depth) at arbitrary query points.
 * Uses the same modular shader code as the water state shader.
 * Includes modifier support for wakes, ripples, currents, and obstacles.
 * Supports analytical shadow attenuation for wave energy reduction behind obstacles.
 *
 * Input:  pointBuffer (storage) - array of vec2<f32> query points
 * Output: resultBuffer (storage) - array of WaterQueryResult structs
 */

import {
  ComputeShader,
  type ComputeShaderConfig,
} from "../../../core/graphics/webgpu/ComputeShader";
import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";
import {
  defineUniformStruct,
  f32,
  u32,
} from "../../../core/graphics/UniformStruct";
import {
  GERSTNER_STEEPNESS,
  NUM_WAVES,
  SWELL_WAVE_COUNT,
  WAVE_AMP_MOD_SPATIAL_SCALE,
  WAVE_AMP_MOD_STRENGTH,
  WAVE_AMP_MOD_TIME_SCALE,
} from "./WaterConstants";
import { fn_calculateModifiers } from "../shaders/water-modifiers.wgsl";
import {
  fn_computeShadowAttenuation,
  struct_ShadowData,
} from "../shaders/shadow-attenuation.wgsl";
import {
  fn_calculateGerstnerWaves,
  struct_WaveModification,
} from "../shaders/gerstner-wave.wgsl";
import { fn_simplex3D } from "../shaders/noise.wgsl";
import { FLOATS_PER_MODIFIER, MAX_MODIFIERS } from "./WaterResources";

const WORKGROUP_SIZE = [64, 1, 1] as const;

/**
 * Uniform struct for water query parameters.
 */
export const WaterQueryUniforms = defineUniformStruct("Params", {
  pointCount: u32,
  time: f32,
  tideHeight: f32,
  waveSourceDirection: f32,
  modifierCount: u32,
  _padding: f32,
});

/**
 * Module containing Params and result structs, plus bindings.
 */
const waterQueryParamsModule: ShaderModule = {
  dependencies: [struct_ShadowData],
  preamble: /*wgsl*/ `
// Query parameters (24 bytes)
struct Params {
  pointCount: u32,
  time: f32,
  tideHeight: f32,
  waveSourceDirection: f32,
  modifierCount: u32,
  _padding: f32,
}

// Result structure (matches WaterQueryResult interface)
struct WaterQueryResult {
  surfaceHeight: f32,
  velocityX: f32,
  velocityY: f32,
  normalX: f32,
  normalY: f32,
  depth: f32,
}
  `,
  bindings: {
    params: { type: "uniform", wgslType: "Params" },
    waveData: { type: "storage", wgslType: "array<f32>" },
    modifiers: { type: "storage", wgslType: "array<f32>" },
    shadowData: { type: "storage", wgslType: "ShadowData" },
    shadowVertices: { type: "storage", wgslType: "array<vec2<f32>>" },
    pointBuffer: { type: "storage", wgslType: "array<vec2<f32>>" },
    resultBuffer: { type: "storageRW", wgslType: "array<WaterQueryResult>" },
  },
  code: "",
};

/**
 * Module containing the compute entry point.
 */
const waterQueryMainModule: ShaderModule = {
  dependencies: [
    waterQueryParamsModule,
    fn_simplex3D,
    struct_WaveModification,
    fn_calculateGerstnerWaves,
    fn_calculateModifiers,
    fn_computeShadowAttenuation,
  ],
  code: /*wgsl*/ `
// Constants
const NUM_WAVES: i32 = ${NUM_WAVES};
const SWELL_WAVE_COUNT: i32 = ${SWELL_WAVE_COUNT};
const GERSTNER_STEEPNESS: f32 = ${GERSTNER_STEEPNESS};
const WAVE_AMP_MOD_SPATIAL_SCALE: f32 = ${WAVE_AMP_MOD_SPATIAL_SCALE};
const WAVE_AMP_MOD_TIME_SCALE: f32 = ${WAVE_AMP_MOD_TIME_SCALE};
const WAVE_AMP_MOD_STRENGTH: f32 = ${WAVE_AMP_MOD_STRENGTH};

// Modifier constants
const MAX_MODIFIERS: u32 = ${MAX_MODIFIERS}u;
const FLOATS_PER_MODIFIER: u32 = ${FLOATS_PER_MODIFIER}u;

// Normal computation sample offset
const NORMAL_SAMPLE_OFFSET: f32 = 1.0;

// Compute height at a point with shadow attenuation
fn computeHeightAtPoint(worldPos: vec2<f32>, ampMod: f32) -> f32 {
  // Compute shadow attenuation
  let shadowAtten = computeShadowAttenuation(worldPos, &shadowData, &shadowVertices);

  // Build wave modifications with shadow-attenuated energy
  var swellMod: WaveModification;
  swellMod.newDirection = vec2<f32>(cos(params.waveSourceDirection), sin(params.waveSourceDirection));
  swellMod.energyFactor = shadowAtten.swellEnergy;

  var chopMod: WaveModification;
  chopMod.newDirection = vec2<f32>(cos(params.waveSourceDirection), sin(params.waveSourceDirection));
  chopMod.energyFactor = shadowAtten.chopEnergy;

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

  return waveResult.x + params.tideHeight;
}

// Compute normal using finite differences
fn computeNormal(worldPos: vec2<f32>, ampMod: f32) -> vec2<f32> {
  let h0 = computeHeightAtPoint(worldPos, ampMod);
  let hx = computeHeightAtPoint(worldPos + vec2<f32>(NORMAL_SAMPLE_OFFSET, 0.0), ampMod);
  let hy = computeHeightAtPoint(worldPos + vec2<f32>(0.0, NORMAL_SAMPLE_OFFSET), ampMod);

  let dx = (hx - h0) / NORMAL_SAMPLE_OFFSET;
  let dy = (hy - h0) / NORMAL_SAMPLE_OFFSET;

  return normalize(vec2<f32>(-dx, -dy));
}

@compute @workgroup_size(${WORKGROUP_SIZE[0]})
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let index = globalId.x;

  if (index >= params.pointCount) {
    return;
  }

  let queryPoint = pointBuffer[index];

  // Sample amplitude modulation noise
  let ampModTime = params.time * WAVE_AMP_MOD_TIME_SCALE;
  let ampMod = 1.0 + simplex3D(vec3<f32>(
    queryPoint.x * WAVE_AMP_MOD_SPATIAL_SCALE,
    queryPoint.y * WAVE_AMP_MOD_SPATIAL_SCALE,
    ampModTime
  )) * WAVE_AMP_MOD_STRENGTH;

  // Compute water height with shadow attenuation
  let surfaceHeight = computeHeightAtPoint(queryPoint, ampMod);

  // Compute normal
  let normal = computeNormal(queryPoint, ampMod);

  // Compute modifier contributions (wakes, ripples, currents, obstacles)
  let modifierResult = calculateModifiers(
    queryPoint.x, queryPoint.y,
    params.modifierCount, MAX_MODIFIERS,
    &modifiers, FLOATS_PER_MODIFIER
  );

  var result: WaterQueryResult;
  result.surfaceHeight = surfaceHeight + modifierResult.x;
  result.velocityX = modifierResult.y;
  result.velocityY = modifierResult.z;
  result.normalX = normal.x;
  result.normalY = normal.y;
  result.depth = 0.0; // Placeholder - use TerrainQuery for depth

  resultBuffer[index] = result;
}
  `,
};

/**
 * Configuration for the water query shader.
 */
export const waterQueryShaderConfig: ComputeShaderConfig = {
  modules: [waterQueryMainModule],
  workgroupSize: WORKGROUP_SIZE,
  label: "WaterQueryShader",
};

/**
 * Create a water query compute shader instance.
 */
export function createWaterQueryShader(): ComputeShader {
  return new ComputeShader(waterQueryShaderConfig);
}
