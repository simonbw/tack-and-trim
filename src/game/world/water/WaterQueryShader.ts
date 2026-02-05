/**
 * Water Query Compute Shader
 *
 * Samples water data (height, velocity, normals, depth) at arbitrary query points.
 * Uses the same modular shader code as the water state shader.
 * Includes modifier support for wakes, ripples, currents, and obstacles.
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
import { fn_computeWaterAtPoint } from "../shaders/water.wgsl";
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
    fn_computeWaterAtPoint,
    fn_calculateModifiers,
    waterQueryParamsModule,
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

@compute @workgroup_size(${WORKGROUP_SIZE[0]})
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let index = globalId.x;

  if (index >= params.pointCount) {
    return;
  }

  let queryPoint = pointBuffer[index];

  // Compute water state using shared module (Gerstner waves)
  let waterResult = computeWaterAtPoint(
    queryPoint,
    params.time,
    params.tideHeight,
    &waveData,
    NUM_WAVES,
    SWELL_WAVE_COUNT,
    GERSTNER_STEEPNESS,
    WAVE_AMP_MOD_SPATIAL_SCALE,
    WAVE_AMP_MOD_TIME_SCALE,
    WAVE_AMP_MOD_STRENGTH,
    params.waveSourceDirection
  );

  // Compute modifier contributions (wakes, ripples, currents, obstacles)
  let modifierResult = calculateModifiers(
    queryPoint.x, queryPoint.y,
    params.modifierCount, MAX_MODIFIERS,
    &modifiers, FLOATS_PER_MODIFIER
  );

  var result: WaterQueryResult;
  result.surfaceHeight = waterResult.surfaceHeight + modifierResult.x;
  result.velocityX = waterResult.velocityX + modifierResult.y;
  result.velocityY = waterResult.velocityY + modifierResult.z;
  result.normalX = waterResult.normalX;
  result.normalY = waterResult.normalY;
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
