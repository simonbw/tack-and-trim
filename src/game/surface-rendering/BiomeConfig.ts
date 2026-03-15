/**
 * Biome terrain coloring configuration.
 *
 * Defines how terrain surfaces are colored based on elevation zones,
 * slope-dependent rock exposure, optional snow, and noise variation.
 */

import type { BiomeConfigJSON } from "../../editor/io/LevelFileFormat";

const MAX_BIOME_ZONES = 6;

/**
 * Runtime biome zone with defaults applied.
 */
export interface BiomeZone {
  maxHeight: number;
  color: [number, number, number];
  colorAlt: [number, number, number];
  noiseBlend: number;
}

/**
 * Runtime biome configuration with all defaults applied.
 */
export interface BiomeConfig {
  zones: BiomeZone[];
  rockColor: [number, number, number];
  rockThreshold: number;
  snowColor: [number, number, number];
  snowlineHeight: number;
  largeNoiseScale: number;
  smallNoiseScale: number;
}

/**
 * Default biome replicating the original sand-only appearance.
 * Single zone covering all heights, no rock/snow, no noise variation.
 */
export const DEFAULT_BIOME_CONFIG: BiomeConfig = {
  zones: [
    {
      maxHeight: 99999,
      color: [0.96, 0.91, 0.76], // dry sand
      colorAlt: [0.76, 0.7, 0.5], // wet sand
      noiseBlend: 0,
    },
  ],
  rockColor: [0.5, 0.5, 0.5],
  rockThreshold: 2.0, // effectively disabled
  snowColor: [0.95, 0.97, 1.0],
  snowlineHeight: -1, // disabled
  largeNoiseScale: 0.005,
  smallNoiseScale: 0.3,
};

/**
 * Parse a BiomeConfigJSON from a level file into a validated BiomeConfig.
 * Returns DEFAULT_BIOME_CONFIG if json is undefined.
 */
export function parseBiomeConfig(
  json: BiomeConfigJSON | undefined,
): BiomeConfig {
  if (!json) {
    return DEFAULT_BIOME_CONFIG;
  }

  const zones = json.zones.slice(0, MAX_BIOME_ZONES).map((z) => ({
    maxHeight: z.maxHeight,
    color: z.color,
    colorAlt: z.colorAlt,
    noiseBlend: z.noiseBlend,
  }));

  // Ensure at least one zone
  if (zones.length === 0) {
    return DEFAULT_BIOME_CONFIG;
  }

  return {
    zones,
    rockColor: json.rockColor,
    rockThreshold: json.rockThreshold,
    snowColor: json.snowColor ?? [0.95, 0.97, 1.0],
    snowlineHeight: json.snowlineHeight ?? -1,
    largeNoiseScale: json.largeNoiseScale ?? 0.005,
    smallNoiseScale: json.smallNoiseScale ?? 0.3,
  };
}

/** Byte size of the packed biome GPU buffer. */
export const BIOME_BUFFER_SIZE = 240;

/**
 * Pack a BiomeConfig into a Float32Array for GPU upload.
 *
 * Layout (240 bytes = 60 floats):
 *   zones[0..5]: 2x vec4 each = {colorAndHeight: vec4, altColorAndBlend: vec4}  (48 floats)
 *   rockColorAndThreshold: vec4  (4 floats)
 *   snowColorAndLine: vec4       (4 floats)
 *   noiseScales: vec2            (2 floats)
 *   zoneCount: u32               (1 float-slot)
 *   _pad: u32                    (1 float-slot)
 */
export function packBiomeBuffer(config: BiomeConfig): Float32Array {
  const data = new Float32Array(60);
  const uintView = new Uint32Array(data.buffer);

  // Pack zones (8 floats per zone, 6 zones max)
  for (let i = 0; i < MAX_BIOME_ZONES; i++) {
    const offset = i * 8;
    if (i < config.zones.length) {
      const zone = config.zones[i];
      // colorAndHeight: vec4(r, g, b, maxHeight)
      data[offset + 0] = zone.color[0];
      data[offset + 1] = zone.color[1];
      data[offset + 2] = zone.color[2];
      data[offset + 3] = zone.maxHeight;
      // altColorAndBlend: vec4(r, g, b, noiseBlend)
      data[offset + 4] = zone.colorAlt[0];
      data[offset + 5] = zone.colorAlt[1];
      data[offset + 6] = zone.colorAlt[2];
      data[offset + 7] = zone.noiseBlend;
    }
    // Unused zones remain zero-filled
  }

  // rockColorAndThreshold: vec4 at offset 48
  data[48] = config.rockColor[0];
  data[49] = config.rockColor[1];
  data[50] = config.rockColor[2];
  data[51] = config.rockThreshold;

  // snowColorAndLine: vec4 at offset 52
  data[52] = config.snowColor[0];
  data[53] = config.snowColor[1];
  data[54] = config.snowColor[2];
  data[55] = config.snowlineHeight;

  // noiseScales: vec2 at offset 56
  data[56] = config.largeNoiseScale;
  data[57] = config.smallNoiseScale;

  // zoneCount: u32 at offset 58
  uintView[58] = config.zones.length;

  // _pad at offset 59 (already 0)

  return data;
}
