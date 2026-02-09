/**
 * Uniform buffer definition for the Terrain Screen compute shader.
 */

import {
  defineUniformStruct,
  f32,
  u32,
} from "../../core/graphics/UniformStruct";

/**
 * Uniforms for the terrain screen compute pass.
 */
export const TerrainScreenUniforms = defineUniformStruct("Params", {
  // Screen dimensions (texture size)
  screenWidth: f32,
  screenHeight: f32,

  // Viewport bounds in world space
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,

  // Terrain tile atlas parameters
  atlasTileSize: u32,
  atlasTilesX: u32,
  atlasTilesY: u32,
  atlasWorldUnitsPerTile: f32,

  // Padding for 16-byte alignment
  _padding0: f32,
  _padding1: f32,
});
