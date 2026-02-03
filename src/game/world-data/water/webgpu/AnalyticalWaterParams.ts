/**
 * Type-safe params buffer definition for analytical water shader.
 *
 * Separated from AnalyticalWaterDataTileCompute to avoid circular imports
 * with AnalyticalWaterStateShader.
 *
 * Different from WaterParams - this shader uses shadow geometry instead
 * of influence textures.
 */

import {
  defineUniformStruct,
  f32,
  u32,
} from "../../../../core/graphics/UniformStruct";

export const AnalyticalWaterParams = defineUniformStruct("Params", {
  time: f32,
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  textureSizeX: f32,
  textureSizeY: f32,
  modifierCount: u32,
  // Wave source direction
  waveSourceDirection: f32,
  // Tide height offset
  tideHeight: f32,
  // Padding to 48 bytes (12 floats)
  _padding1: f32,
});
