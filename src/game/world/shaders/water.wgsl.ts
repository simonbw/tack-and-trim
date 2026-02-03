/**
 * Water shader modules for wave and flow computation.
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";
import {
  terrainHeightCoreModule,
  terrainStructuresModule,
} from "./terrain.wgsl";

/**
 * Water data calculation module.
 * Computes water surface data (height, flow, etc.) at any world position.
 *
 * Depends on terrain height for underwater terrain interaction.
 *
 * This is a placeholder - will be implemented with actual Gerstner wave
 * and flow field calculations in the future.
 */
export const waterDataModule: ShaderModule = {
  code: /*wgsl*/ `
    struct WaveSource {
      // Placeholder - will define actual wave source data structure
      pos: vec2<f32>,
      amplitude: f32,
      wavelength: f32,
    }

    struct WaterParams {
      // Placeholder - will define actual water parameters
      time: f32,
      baseHeight: f32,
    }

    @group(0) @binding(3) var<storage, read> waveSources: array<WaveSource>;
    @group(0) @binding(4) var<uniform> waterParams: WaterParams;

    fn calculateWaterData(worldPos: vec2<f32>) -> vec4<f32> {
      // Placeholder implementation
      // Will be replaced with actual Gerstner wave calculation

      let terrainH = calculateTerrainHeight(worldPos);

      // For now, return placeholder data:
      // x: water surface height
      // y: flow velocity x
      // z: flow velocity y
      // w: depth
      return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }
  `,
  bindings: {
    waveSources: {
      type: "storage",
      wgslType: "array<WaveSource>",
    },
    waterParams: {
      type: "uniform",
      wgslType: "WaterParams",
    },
  },
  dependencies: [terrainHeightCoreModule, terrainStructuresModule],
};
