/**
 * Terrain Query Compute Shader
 *
 * Samples terrain data (height, normal, terrain type) at arbitrary query points.
 * Uses the same modular shader code as the terrain state shader.
 *
 * Input:  pointBuffer (storage) - array of vec2<f32> query points
 * Output: resultBuffer (storage) - array of TerrainQueryResult structs
 */

import { ComputeShader } from "../../../core/graphics/webgpu/ComputeShader";

const bindings = {
  params: { type: "uniform" },
  pointBuffer: { type: "storage" },
  resultBuffer: { type: "storageRW" },
} as const;

/**
 * Terrain query compute shader.
 * Computes terrain state at provided query points.
 *
 * TODO: Integrate full terrain computation using terrain shader modules.
 * For now, returns placeholder data to get the infrastructure working.
 */
export class TerrainQueryShader extends ComputeShader<typeof bindings> {
  readonly bindings = bindings;
  readonly workgroupSize = [64, 1, 1] as const;

  protected mainCode = /*wgsl*/ `
// Query parameters
struct Params {
  pointCount: u32,
  _padding: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> pointBuffer: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> resultBuffer: array<TerrainQueryResult>;

// Result structure (matches TerrainQueryResult interface)
// stride = 4 floats
struct TerrainQueryResult {
  height: f32,
  normalX: f32,
  normalY: f32,
  terrainType: f32,
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let index = globalId.x;

  if (index >= params.pointCount) {
    return;
  }

  let queryPoint = pointBuffer[index];

  // TODO: Compute actual terrain state using terrain modules
  // For now, return simple placeholder data
  var result: TerrainQueryResult;
  result.height = sin(queryPoint.x * 0.01) * cos(queryPoint.y * 0.01) * 10.0;
  result.normalX = 0.0;
  result.normalY = 1.0;
  result.terrainType = 0.0; // Water

  resultBuffer[index] = result;
}
`;
}
