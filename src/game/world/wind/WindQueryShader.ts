/**
 * Wind Query Compute Shader
 *
 * Samples wind data (velocity, speed, direction) at arbitrary query points.
 * Uses the same modular shader code as the wind state shader.
 *
 * Input:  pointBuffer (storage) - array of vec2<f32> query points
 * Output: resultBuffer (storage) - array of WindQueryResult structs
 */

import { ComputeShader } from "../../../core/graphics/webgpu/ComputeShader";

const bindings = {
  params: { type: "uniform" },
  pointBuffer: { type: "storage" },
  resultBuffer: { type: "storageRW" },
} as const;

/**
 * Wind query compute shader.
 * Computes wind state at provided query points.
 *
 * TODO: Integrate full wind computation using wind shader modules.
 * For now, returns placeholder data to get the infrastructure working.
 */
export class WindQueryShader extends ComputeShader<typeof bindings> {
  readonly bindings = bindings;
  readonly workgroupSize = [64, 1, 1] as const;

  protected mainCode = /*wgsl*/ `
// Query parameters
struct Params {
  pointCount: u32,
  time: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> pointBuffer: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> resultBuffer: array<WindQueryResult>;

// Result structure (matches WindQueryResult interface)
// stride = 4 floats
struct WindQueryResult {
  velocityX: f32,
  velocityY: f32,
  speed: f32,
  direction: f32,
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let index = globalId.x;

  if (index >= params.pointCount) {
    return;
  }

  let queryPoint = pointBuffer[index];

  // TODO: Compute actual wind state using wind modules
  // For now, return simple placeholder data
  var result: WindQueryResult;
  let windX = cos(queryPoint.x * 0.001 + params.time * 0.1);
  let windY = sin(queryPoint.y * 0.001 + params.time * 0.1);

  result.velocityX = windX * 10.0; // 10 m/s placeholder
  result.velocityY = windY * 10.0;
  result.speed = sqrt(windX * windX + windY * windY) * 10.0;
  result.direction = atan2(windY, windX);

  resultBuffer[index] = result;
}
`;
}
