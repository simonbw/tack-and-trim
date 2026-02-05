/**
 * Terrain Height Compute Shader
 *
 * Computes terrain height at each pixel using contour-based signed distance.
 * Output is a single-channel r32float texture containing world-space terrain height.
 *
 * This is the second pass of the multi-pass surface rendering pipeline.
 */

import {
  ComputeShader,
  type ComputeShaderConfig,
} from "../../core/graphics/webgpu/ComputeShader";
import type { ShaderModule } from "../../core/graphics/webgpu/ShaderModule";
import {
  struct_ContourData,
  fn_computeTerrainHeight,
} from "../world/shaders/terrain.wgsl";
import { DEFAULT_DEPTH } from "../world/terrain/TerrainConstants";

const WORKGROUP_SIZE = [8, 8] as const;

/**
 * Params module with uniforms and bindings for terrain height computation.
 */
const terrainHeightParamsModule: ShaderModule = {
  preamble: /*wgsl*/ `
// Terrain height computation parameters
struct Params {
  screenWidth: f32,
  screenHeight: f32,
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  contourCount: u32,
  _padding0: u32,
}

// Terrain constants
const DEFAULT_DEPTH: f32 = ${DEFAULT_DEPTH}.0;
`,
  bindings: {
    params: { type: "uniform", wgslType: "Params" },
    vertices: { type: "storage", wgslType: "array<vec2<f32>>" },
    contours: { type: "storage", wgslType: "array<ContourData>" },
    children: { type: "storage", wgslType: "array<u32>" },
    outputTexture: { type: "storageTexture", format: "r32float" },
  },
  code: "",
};

/**
 * Main compute module for terrain height.
 */
const terrainHeightMainModule: ShaderModule = {
  dependencies: [
    terrainHeightParamsModule,
    struct_ContourData,
    fn_computeTerrainHeight,
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

@compute @workgroup_size(${WORKGROUP_SIZE[0]}, ${WORKGROUP_SIZE[1]})
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let pixel = global_id.xy;

  // Bounds check
  if (pixel.x >= u32(params.screenWidth) || pixel.y >= u32(params.screenHeight)) {
    return;
  }

  let worldPos = pixelToWorld(pixel);

  // Compute terrain height using contour-based algorithm
  // Vertices are pre-sampled from Catmull-Rom splines on the CPU
  let terrainHeight = computeTerrainHeight(
    worldPos,
    &vertices,
    &contours,
    params.contourCount,
    DEFAULT_DEPTH
  );

  // Write to output texture
  textureStore(outputTexture, pixel, vec4<f32>(terrainHeight, 0.0, 0.0, 0.0));
}
`,
};

const terrainHeightShaderConfig: ComputeShaderConfig = {
  modules: [terrainHeightMainModule],
  workgroupSize: WORKGROUP_SIZE,
  label: "TerrainHeightShader",
};

export function createTerrainHeightShader(): ComputeShader {
  return new ComputeShader(terrainHeightShaderConfig);
}
