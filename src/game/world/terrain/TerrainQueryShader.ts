/**
 * Terrain Query Compute Shader
 *
 * Samples terrain data (height, normal, terrain type) at arbitrary query points.
 * Uses terrain shader modules for signed distance computation.
 *
 * Input:  pointBuffer (storage) - array of vec2<f32> query points
 * Output: resultBuffer (storage) - array of TerrainQueryResult structs
 */

import {
  defineUniformStruct,
  f32,
  u32,
} from "../../../core/graphics/UniformStruct";
import {
  ComputeShader,
  type ComputeShaderConfig,
} from "../../../core/graphics/webgpu/ComputeShader";
import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";
import {
  fn_computeTerrainHeight,
  fn_computeTerrainNormal,
  struct_ContourData,
} from "../shaders/terrain.wgsl";

const WORKGROUP_SIZE = [64, 1, 1] as const;

/**
 * Uniform struct for terrain query parameters.
 */
export const TerrainQueryUniforms = defineUniformStruct("Params", {
  pointCount: u32,
  contourCount: u32,
  defaultDepth: f32,
  _padding: f32,
});

/**
 * Module containing Params and result structs, plus bindings.
 */
const terrainQueryParamsModule: ShaderModule = {
  preamble: /*wgsl*/ `
// Query parameters
struct Params {
  pointCount: u32,
  contourCount: u32,
  defaultDepth: f32,
  _padding: f32,
}

// Result structure (matches TerrainQueryResult interface)
// stride = 4 floats
struct TerrainQueryResult {
  height: f32,
  normalX: f32,
  normalY: f32,
  terrainType: f32,
}
  `,
  bindings: {
    params: { type: "uniform", wgslType: "Params" },
    pointBuffer: { type: "storage", wgslType: "array<vec2<f32>>" },
    resultBuffer: { type: "storageRW", wgslType: "array<TerrainQueryResult>" },
    packedTerrain: { type: "storage", wgslType: "array<u32>" },
  },
  code: "",
};

/**
 * Module containing the compute entry point.
 */
const terrainQueryMainModule: ShaderModule = {
  dependencies: [
    struct_ContourData,
    fn_computeTerrainHeight,
    fn_computeTerrainNormal,
    terrainQueryParamsModule,
  ],
  code: /*wgsl*/ `
@compute @workgroup_size(${WORKGROUP_SIZE[0]})
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let index = globalId.x;

  if (index >= params.pointCount) {
    return;
  }

  let queryPoint = pointBuffer[index];

  var result: TerrainQueryResult;
  // Vertices are pre-sampled from Catmull-Rom splines on the CPU
  result.height = computeTerrainHeight(
    queryPoint,
    &packedTerrain,
    params.contourCount,
    params.defaultDepth
  );

  // Compute normal
  let normal = computeTerrainNormal(
    queryPoint,
    &packedTerrain,
    params.contourCount,
    params.defaultDepth
  );
  result.normalX = normal.x;
  result.normalY = normal.y;

  // Terrain type: 0 = water (negative height), 1+ = land
  result.terrainType = select(0.0, 1.0, result.height >= 0.0);

  resultBuffer[index] = result;
}
  `,
};

/**
 * Configuration for the terrain query shader.
 */
export const terrainQueryShaderConfig: ComputeShaderConfig = {
  modules: [terrainQueryMainModule],
  workgroupSize: WORKGROUP_SIZE,
  label: "TerrainQueryShader",
};

/**
 * Create a terrain query compute shader instance.
 */
export function createTerrainQueryShader(): ComputeShader {
  return new ComputeShader(terrainQueryShaderConfig);
}
