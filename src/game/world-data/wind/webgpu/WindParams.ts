/**
 * Type-safe params buffer definition for wind shader.
 *
 * Separated from WindTileCompute to avoid circular imports
 * with WindStateShader.
 */

import {
  defineUniformStruct,
  f32,
  vec2,
} from "../../../../core/graphics/UniformStruct";

// Type-safe params buffer definition - single source of truth for shader struct
export const WindParams = defineUniformStruct("Params", {
  time: f32,
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  textureSizeX: f32,
  textureSizeY: f32,
  _padding: f32,
  baseWind: vec2, // baseWindX, baseWindY
  _padding2: vec2, // padding2, padding3
  influenceSpeedFactor: f32,
  influenceDirectionOffset: f32,
  influenceTurbulence: f32,
  _padding4: f32,
});
