/**
 * Terrain Tile Compute Shader
 *
 * Computes terrain height for a single tile and writes to an atlas slot.
 * Output is a portion of the terrain atlas texture (r32float).
 *
 * This shader is used by the terrain tile cache to render individual tiles
 * which are then composited during the surface render pass.
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
 * Params module with uniforms and bindings for terrain tile computation.
 */
const terrainTileParamsModule: ShaderModule = {
  preamble: /*wgsl*/ `
// Terrain tile computation parameters
struct TileParams {
  // Tile pixel size
  tileSize: u32,

  // Atlas offset in pixels (where to write)
  atlasOffsetX: u32,
  atlasOffsetY: u32,

  // Terrain params
  contourCount: u32,

  // World-space bounds of this tile
  tileWorldLeft: f32,
  tileWorldTop: f32,
  tileWorldWidth: f32,
  tileWorldHeight: f32,
}

// Terrain constants
const DEFAULT_DEPTH: f32 = ${DEFAULT_DEPTH}.0;
`,
  bindings: {
    params: { type: "uniform", wgslType: "TileParams" },
    vertices: { type: "storage", wgslType: "array<vec2<f32>>" },
    contours: { type: "storage", wgslType: "array<ContourData>" },
    children: { type: "storage", wgslType: "array<u32>" },
    atlasTexture: { type: "storageTexture", format: "r32float" },
  },
  code: "",
};

/**
 * Main compute module for terrain tile.
 */
const terrainTileMainModule: ShaderModule = {
  dependencies: [
    terrainTileParamsModule,
    struct_ContourData,
    fn_computeTerrainHeight,
  ],
  code: /*wgsl*/ `
// Convert tile-local pixel coordinates to world position
fn tilePixelToWorld(pixel: vec2<u32>) -> vec2<f32> {
  let uv = vec2<f32>(
    f32(pixel.x) / f32(params.tileSize),
    f32(pixel.y) / f32(params.tileSize)
  );
  return vec2<f32>(
    params.tileWorldLeft + uv.x * params.tileWorldWidth,
    params.tileWorldTop + uv.y * params.tileWorldHeight
  );
}

@compute @workgroup_size(${WORKGROUP_SIZE[0]}, ${WORKGROUP_SIZE[1]})
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let localPixel = global_id.xy;

  // Bounds check against tile size
  if (localPixel.x >= params.tileSize || localPixel.y >= params.tileSize) {
    return;
  }

  let worldPos = tilePixelToWorld(localPixel);

  // Compute terrain height using contour-based algorithm
  let terrainHeight = computeTerrainHeight(
    worldPos,
    &vertices,
    &contours,
    params.contourCount,
    DEFAULT_DEPTH
  );

  // Write to atlas at the offset position
  let atlasPixel = vec2<u32>(
    params.atlasOffsetX + localPixel.x,
    params.atlasOffsetY + localPixel.y
  );
  textureStore(atlasTexture, atlasPixel, vec4<f32>(terrainHeight, 0.0, 0.0, 0.0));
}
`,
};

const terrainTileShaderConfig: ComputeShaderConfig = {
  modules: [terrainTileMainModule],
  workgroupSize: WORKGROUP_SIZE,
  label: "TerrainTileShader",
};

export function createTerrainTileShader(): ComputeShader {
  return new ComputeShader(terrainTileShaderConfig);
}
