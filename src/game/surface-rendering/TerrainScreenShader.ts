/**
 * Terrain Screen Compute Shader
 *
 * Samples terrain height from the tile atlas and writes to a screen-space
 * r32float texture. This runs before WaterHeightShader so that water
 * calculations can access terrain height for refraction and shoaling.
 *
 * Input: Terrain tile atlas (from LODTerrainTileCache)
 * Output: Screen-space terrain height texture (r32float)
 */

import {
  ComputeShader,
  type ComputeShaderConfig,
} from "../../core/graphics/webgpu/ComputeShader";
import type { ShaderModule } from "../../core/graphics/webgpu/ShaderModule";

const WORKGROUP_SIZE = [8, 8] as const;

/**
 * Params module with uniforms and bindings for terrain screen computation.
 */
const terrainScreenParamsModule: ShaderModule = {
  preamble: /*wgsl*/ `
// Terrain screen computation parameters
struct Params {
  screenWidth: f32,
  screenHeight: f32,
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,

  // Terrain tile atlas parameters
  atlasTileSize: u32,
  atlasTilesX: u32,
  atlasTilesY: u32,
  atlasWorldUnitsPerTile: f32,

  _padding0: f32,
  _padding1: f32,
}
`,
  bindings: {
    params: { type: "uniform", wgslType: "Params" },
    terrainTileAtlas: {
      type: "texture",
      viewDimension: "2d",
      sampleType: "unfilterable-float",
    },
    outputTexture: { type: "storageTexture", format: "r32float" },
  },
  code: "",
};

/**
 * Main compute module for terrain screen pass.
 */
const terrainScreenComputeModule: ShaderModule = {
  dependencies: [terrainScreenParamsModule],
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

// Sample terrain height from tile atlas
// This logic matches SurfaceCompositeShader.sampleTerrainHeight
fn sampleTerrainHeight(worldPos: vec2<f32>) -> f32 {
  // Convert world position to tile coordinates
  let worldUnitsPerTile = params.atlasWorldUnitsPerTile;
  let tileSize = params.atlasTileSize;

  // Calculate which tile this world position is in
  let tileX = floor(worldPos.x / worldUnitsPerTile);
  let tileY = floor(worldPos.y / worldUnitsPerTile);

  // Calculate position within the tile (0-1)
  // Clamp to [0, 1) to handle floating point precision at boundaries
  let localX = clamp((worldPos.x - tileX * worldUnitsPerTile) / worldUnitsPerTile, 0.0, 0.999999);
  let localY = clamp((worldPos.y - tileY * worldUnitsPerTile) / worldUnitsPerTile, 0.0, 0.999999);

  // Calculate atlas slot from tile coordinates using modulo for wrapping
  // This gives us the slot that would contain this tile if it's cached
  let slotX = i32(tileX) % i32(params.atlasTilesX);
  let slotY = i32(tileY) % i32(params.atlasTilesY);

  // Handle negative coordinates (WGSL % can return negative values)
  let wrappedSlotX = u32(select(slotX, slotX + i32(params.atlasTilesX), slotX < 0));
  let wrappedSlotY = u32(select(slotY, slotY + i32(params.atlasTilesY), slotY < 0));

  // Calculate pixel coordinates within the tile, then offset to atlas position
  // Use the same mapping as the tile shader: pixel i -> world (i/tileSize)
  // So world -> pixel is: localX * tileSize, clamped to valid pixel range
  let pixelInTileX = min(u32(localX * f32(tileSize)), tileSize - 1u);
  let pixelInTileY = min(u32(localY * f32(tileSize)), tileSize - 1u);

  let atlasPixelX = wrappedSlotX * tileSize + pixelInTileX;
  let atlasPixelY = wrappedSlotY * tileSize + pixelInTileY;

  let texCoord = vec2<i32>(i32(atlasPixelX), i32(atlasPixelY));
  return textureLoad(terrainTileAtlas, texCoord, 0).r;
}

@compute @workgroup_size(${WORKGROUP_SIZE[0]}, ${WORKGROUP_SIZE[1]})
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let pixel = global_id.xy;

  // Bounds check
  if (pixel.x >= u32(params.screenWidth) || pixel.y >= u32(params.screenHeight)) {
    return;
  }

  let worldPos = pixelToWorld(pixel);
  let terrainHeight = sampleTerrainHeight(worldPos);

  // Write to output texture
  textureStore(outputTexture, pixel, vec4<f32>(terrainHeight, 0.0, 0.0, 0.0));
}
`,
};

const terrainScreenShaderConfig: ComputeShaderConfig = {
  modules: [terrainScreenComputeModule],
  workgroupSize: WORKGROUP_SIZE,
  label: "TerrainScreenShader",
};

export function createTerrainScreenShader(): ComputeShader {
  return new ComputeShader(terrainScreenShaderConfig);
}
