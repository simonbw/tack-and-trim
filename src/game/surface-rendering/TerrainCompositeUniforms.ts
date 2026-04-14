/**
 * Uniform buffer definition for the Terrain Composite shader.
 *
 * Renders above-water terrain (sand, rock, snow) into the scene color target
 * before the water filter pass.
 */

import {
  defineUniformStruct,
  f32,
  i32,
  u32,
  mat3x3,
} from "../../core/graphics/UniformStruct";

export const TerrainCompositeUniforms = defineUniformStruct("Params", {
  // Clip-to-world matrix (stored as 3 vec4s for alignment)
  cameraMatrix: mat3x3,

  // Screen dimensions
  screenWidth: f32,
  screenHeight: f32,

  // Expanded viewport bounds in world space (for height texture UV lookups)
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,

  time: f32,
  tideHeight: f32,
  hasTerrainData: i32,

  // Terrain tile atlas parameters
  atlasTileSize: u32,
  atlasTilesX: u32,
  atlasTilesY: u32,
  atlasWorldUnitsPerTile: f32,
});
