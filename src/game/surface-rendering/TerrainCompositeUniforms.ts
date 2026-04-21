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
  // Clip → world for the actual screen (used for world-position reconstruction).
  cameraMatrix: mat3x3,

  // Screen dimensions (logical/CSS pixels)
  screenWidth: f32,
  screenHeight: f32,

  // Device pixel ratio — the fragment shader's fragPos.xy is in physical
  // framebuffer pixels, but the surface textures are sized at logical+margin
  // resolution. Divide fragPos.xy by this to get logical pixel coords.
  pixelRatio: f32,

  time: f32,
  tideHeight: f32,
  hasTerrainData: i32,

  // Terrain tile atlas parameters
  atlasTileSize: u32,
  atlasTilesX: u32,
  atlasTilesY: u32,
  atlasWorldUnitsPerTile: f32,
});
