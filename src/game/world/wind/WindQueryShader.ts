/**
 * Wind Query Compute Shader
 *
 * Samples wind data (velocity, speed, direction) at arbitrary query points.
 * Uses wind shader modules for consistent computation with rendering.
 *
 * Input:  pointBuffer (storage) - array of vec2<f32> query points
 * Output: resultBuffer (storage) - array of WindQueryResult structs
 */

import {
  ComputeShader,
  type ComputeShaderConfig,
} from "../../../core/graphics/webgpu/ComputeShader";
import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";
import {
  WIND_ANGLE_VARIATION,
  WIND_NOISE_SPATIAL_SCALE,
  WIND_NOISE_TIME_SCALE,
  WIND_SPEED_VARIATION,
} from "./WindConstants";
import { windQueryComputeModule } from "../shaders/wind.wgsl";

const WORKGROUP_SIZE = [64, 1, 1] as const;

/**
 * Module containing Params and result structs, plus bindings.
 */
const windQueryParamsModule: ShaderModule = {
  preamble: /*wgsl*/ `
// Query parameters
struct Params {
  pointCount: u32,
  time: f32,
  baseWindX: f32,
  baseWindY: f32,
  influenceSpeedFactor: f32,
  influenceDirectionOffset: f32,
  influenceTurbulence: f32,
  _padding: f32,
}

// Result structure (matches WindQueryResult interface)
// stride = 4 floats
struct WindQueryResult {
  velocityX: f32,
  velocityY: f32,
  speed: f32,
  direction: f32,
}
  `,
  bindings: {
    params: { type: "uniform", wgslType: "Params" },
    pointBuffer: { type: "storage", wgslType: "array<vec2<f32>>" },
    resultBuffer: { type: "storageRW", wgslType: "array<WindQueryResult>" },
  },
  code: "",
};

/**
 * Module containing the compute entry point.
 */
const windQueryMainModule: ShaderModule = {
  dependencies: [windQueryComputeModule, windQueryParamsModule],
  code: /*wgsl*/ `
// Wind constants
const WIND_NOISE_SPATIAL_SCALE: f32 = ${WIND_NOISE_SPATIAL_SCALE};
const WIND_NOISE_TIME_SCALE: f32 = ${WIND_NOISE_TIME_SCALE};
const WIND_SPEED_VARIATION: f32 = ${WIND_SPEED_VARIATION};
const WIND_ANGLE_VARIATION: f32 = ${WIND_ANGLE_VARIATION};

@compute @workgroup_size(${WORKGROUP_SIZE[0]})
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let index = globalId.x;

  if (index >= params.pointCount) {
    return;
  }

  let queryPoint = pointBuffer[index];

  // Compute wind using shared module
  let windResult = computeWindAtPoint(
    queryPoint,
    params.time,
    vec2<f32>(params.baseWindX, params.baseWindY),
    params.influenceSpeedFactor,
    params.influenceDirectionOffset,
    params.influenceTurbulence,
    WIND_NOISE_SPATIAL_SCALE,
    WIND_NOISE_TIME_SCALE,
    WIND_SPEED_VARIATION,
    WIND_ANGLE_VARIATION
  );

  var result: WindQueryResult;
  result.velocityX = windResult.velocity.x;
  result.velocityY = windResult.velocity.y;
  result.speed = windResult.speed;
  result.direction = windResult.direction;

  resultBuffer[index] = result;
}
  `,
};

/**
 * Configuration for the wind query shader.
 */
export const windQueryShaderConfig: ComputeShaderConfig = {
  modules: [windQueryMainModule],
  workgroupSize: WORKGROUP_SIZE,
  label: "WindQueryShader",
};

/**
 * Create a wind query compute shader instance.
 */
export function createWindQueryShader(): ComputeShader {
  return new ComputeShader(windQueryShaderConfig);
}
