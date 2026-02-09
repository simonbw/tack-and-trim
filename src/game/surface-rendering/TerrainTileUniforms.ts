/**
 * Uniform buffer definition for the Terrain Tile compute shader.
 *
 * This shader renders a single terrain tile to an atlas slot.
 */

import {
  defineUniformStruct,
  f32,
  u32,
} from "../../core/graphics/UniformStruct";

/**
 * Uniforms for the terrain tile compute pass.
 */
export const TerrainTileUniforms = defineUniformStruct("TileParams", {
  // Tile pixel size (e.g., 256)
  tileSize: u32,

  // Atlas slot offset in pixels (where to write in the atlas)
  atlasOffsetX: u32,
  atlasOffsetY: u32,

  // Terrain params
  contourCount: u32,

  // World-space bounds of this tile
  tileWorldLeft: f32,
  tileWorldTop: f32,
  tileWorldWidth: f32,
  tileWorldHeight: f32,
});
