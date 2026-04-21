/**
 * Uniform buffer definition for the Terrain Screen compute shader.
 */

import {
  defineUniformStruct,
  f32,
  mat3x3,
  u32,
} from "../../core/graphics/UniformStruct";

/**
 * Uniforms for the terrain screen compute pass.
 */
export const TerrainScreenUniforms = defineUniformStruct("Params", {
  // Clip-space → world transform for the output texture. Texel (x,y) maps to
  // clip = (2*(x+0.5)/W - 1, 1 - 2*(y+0.5)/H), then world = M * vec3(clip, 1).
  // Covers the screen-aligned expanded viewport (includes rotation).
  texClipToWorld: mat3x3,

  // Dimensions of the output texture in texels.
  textureWidth: f32,
  textureHeight: f32,

  // Terrain tile atlas parameters
  atlasTileSize: u32,
  atlasTilesX: u32,
  atlasTilesY: u32,
  atlasWorldUnitsPerTile: f32,
});
