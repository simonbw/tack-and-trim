/**
 * Wind Field Compute Shader
 *
 * Writes per-texel wind velocity to a screen-space rgba16float texture.
 * Encoding: (velocityX, velocityY, speed, 0).
 *
 * Output is consumed by downstream surface shaders (WaterFilterShader)
 * for ripple shading, whitecap thresholds, etc.
 */

import {
  ComputeShader,
  type ComputeShaderConfig,
} from "../../core/graphics/webgpu/ComputeShader";
import type { ShaderModule } from "../../core/graphics/webgpu/ShaderModule";
import { fn_computeWindAtPoint } from "../world/shaders/wind.wgsl";
import { fn_lookupWindMeshBlended } from "../world/shaders/wind-mesh-packed.wgsl";
import {
  MAX_WIND_SOURCES,
  WIND_ANGLE_VARIATION,
  WIND_FLOW_CYCLE_PERIOD,
  WIND_NOISE_SPATIAL_SCALE,
  WIND_NOISE_TIME_SCALE,
  WIND_SLOW_TIME_SCALE,
  WIND_SPEED_VARIATION,
} from "../world/wind/WindConstants";

const WORKGROUP_SIZE = [8, 8] as const;

const windFieldParamsModule: ShaderModule = {
  preamble: /*wgsl*/ `
struct Params {
  texClipToWorld: mat3x3<f32>,

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
}
`,
  bindings: {
    params: { type: "uniform", wgslType: "Params" },
    packedWindMesh: { type: "storage", wgslType: "array<u32>" },
    outputTexture: { type: "storageTexture", format: "rgba16float" },
  },
  code: "",
};

const windFieldComputeModule: ShaderModule = {
  dependencies: [
    windFieldParamsModule,
    fn_computeWindAtPoint,
    fn_lookupWindMeshBlended,
  ],
  code: /*wgsl*/ `
const WIND_NOISE_SPATIAL_SCALE: f32 = ${WIND_NOISE_SPATIAL_SCALE};
const WIND_NOISE_TIME_SCALE: f32 = ${WIND_NOISE_TIME_SCALE};
const WIND_SPEED_VARIATION: f32 = ${WIND_SPEED_VARIATION};
const WIND_ANGLE_VARIATION: f32 = ${WIND_ANGLE_VARIATION};
const WIND_FLOW_CYCLE_PERIOD: f32 = ${WIND_FLOW_CYCLE_PERIOD};
const WIND_SLOW_TIME_SCALE: f32 = ${WIND_SLOW_TIME_SCALE};

fn pixelToWorld(pixel: vec2<u32>) -> vec2<f32> {
  let uv = vec2<f32>(
    (f32(pixel.x) + 0.5) / f32(params.textureWidth),
    (f32(pixel.y) + 0.5) / f32(params.textureHeight)
  );
  let clip = vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  return (params.texClipToWorld * vec3<f32>(clip, 1.0)).xy;
}

@compute @workgroup_size(${WORKGROUP_SIZE[0]}, ${WORKGROUP_SIZE[1]})
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let pixel = global_id.xy;

  if (pixel.x >= params.textureWidth || pixel.y >= params.textureHeight) {
    return;
  }

  let worldPos = pixelToWorld(pixel);
  let baseWind = vec2<f32>(params.baseWindX, params.baseWindY);

  var weights: array<f32, ${MAX_WIND_SOURCES}>;
  weights[0] = params.weights0;
  weights[1] = params.weights1;
  weights[2] = params.weights2;
  weights[3] = params.weights3;
  weights[4] = params.weights4;
  weights[5] = params.weights5;
  weights[6] = params.weights6;
  weights[7] = params.weights7;

  let meshResult = lookupWindMeshBlended(worldPos, &packedWindMesh, weights);
  let speedFactor = select(1.0, meshResult.speedFactor, meshResult.found);
  let dirOffset = select(0.0, meshResult.directionOffset, meshResult.found);
  let turb = select(0.0, meshResult.turbulence, meshResult.found);

  let windResult = computeWindAtPoint(
    worldPos,
    params.time,
    baseWind,
    speedFactor,
    dirOffset,
    turb,
    WIND_NOISE_SPATIAL_SCALE,
    WIND_NOISE_TIME_SCALE,
    WIND_SPEED_VARIATION,
    WIND_ANGLE_VARIATION,
    WIND_FLOW_CYCLE_PERIOD,
    WIND_SLOW_TIME_SCALE
  );

  textureStore(
    outputTexture,
    pixel,
    vec4<f32>(windResult.velocity.x, windResult.velocity.y, windResult.speed, 0.0)
  );
}
`,
};

const windFieldShaderConfig: ComputeShaderConfig = {
  modules: [windFieldComputeModule],
  workgroupSize: WORKGROUP_SIZE,
  label: "WindFieldShader",
};

export function createWindFieldShader(): ComputeShader {
  return new ComputeShader(windFieldShaderConfig);
}
