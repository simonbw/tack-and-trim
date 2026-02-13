/**
 * Uniform buffer definition for the Surface Composite shader.
 */

import {
  defineUniformStruct,
  f32,
  i32,
  u32,
  mat3x3,
} from "../../core/graphics/UniformStruct";

/**
 * Uniforms for the surface composite pass.
 */
export const SurfaceCompositeUniforms = defineUniformStruct("Params", {
  // Camera matrix for screen-to-world transform (stored as 3 vec4s for alignment)
  cameraMatrix: mat3x3,

  // Screen dimensions
  screenWidth: f32,
  screenHeight: f32,

  // Expanded viewport bounds in world space (for height texture UV lookups)
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,

  // Time and rendering params
  time: f32,
  tideHeight: f32,
  shallowThreshold: f32,
  hasTerrainData: i32,

  // Terrain tile atlas parameters
  atlasTileSize: u32,
  atlasTilesX: u32,
  atlasTilesY: u32,
  atlasWorldUnitsPerTile: f32,

  // Camera viewport bounds in world space (for clip-to-world mapping)
  cameraLeft: f32,
  cameraTop: f32,
  cameraWidth: f32,
  cameraHeight: f32,
});
