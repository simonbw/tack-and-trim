/**
 * Water shader modules for wave and flow computation.
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";
import { fn_simplex3D } from "./noise.wgsl";
import {
  struct_WaveModification,
  fn_calculateGerstnerWaves,
} from "./gerstner-wave.wgsl";

/**
 * Wave source structure definition.
 */
export const struct_WaveSource: ShaderModule = {
  code: /*wgsl*/ `
    struct WaveSource {
      // Placeholder - will define actual wave source data structure
      pos: vec2<f32>,
      amplitude: f32,
      wavelength: f32,
    }
  `,
  dependencies: [],
};

/**
 * Water parameters structure definition.
 */
export const struct_WaterParams: ShaderModule = {
  code: /*wgsl*/ `
    struct WaterParams {
      // Placeholder - will define actual water parameters
      time: f32,
      baseHeight: f32,
    }
  `,
  dependencies: [],
};

/**
 * Water data calculation function.
 * Computes water surface data (height, flow, etc.) at any world position.
 *
 * Depends on terrain height for underwater terrain interaction.
 *
 * This is a placeholder - will be implemented with actual Gerstner wave
 * and flow field calculations in the future.
 */
export const fn_calculateWaterData: ShaderModule = {
  code: /*wgsl*/ `
    fn calculateWaterData(worldPos: vec2<f32>) -> vec4<f32> {
      // Placeholder implementation
      // Will be replaced with actual Gerstner wave calculation

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
  dependencies: [struct_WaveSource, struct_WaterParams],
};

/**
 * Water query result structure.
 */
export const struct_WaterResult: ShaderModule = {
  code: /*wgsl*/ `
    // Water query result structure
    struct WaterResult {
      surfaceHeight: f32,
      velocityX: f32,
      velocityY: f32,
      normalX: f32,
      normalY: f32,
      dhdt: f32,
    }
  `,
  dependencies: [],
};

/**
 * Helper function to compute water height at a point (without normal).
 */
export const fn_computeWaterHeightAtPoint: ShaderModule = {
  code: /*wgsl*/ `
    // Helper: compute water height at a point (without normal)
    fn computeWaterHeightAtPoint(
      worldPos: vec2<f32>,
      time: f32,
      waveData: ptr<storage, array<f32>, read>,
      numWaves: i32,
      swellWaveCount: i32,
      steepness: f32,
      ampMod: f32,
      waveSourceDirection: f32
    ) -> vec4<f32> {
      // No diffraction for queries - use full energy
      var swellMod: WaveModification;
      swellMod.energyFactor = 1.0;
      swellMod.newDirection = vec2<f32>(cos(waveSourceDirection), sin(waveSourceDirection));

      var chopMod: WaveModification;
      chopMod.energyFactor = 1.0;
      chopMod.newDirection = vec2<f32>(cos(waveSourceDirection), sin(waveSourceDirection));

      return calculateGerstnerWaves(
        worldPos,
        time,
        waveData,
        numWaves,
        swellWaveCount,
        steepness,
        swellMod,
        chopMod,
        ampMod,
        waveSourceDirection
      );
    }
  `,
  dependencies: [struct_WaveModification, fn_calculateGerstnerWaves],
};

/**
 * Compute water normal using finite differences.
 */
export const fn_computeWaterNormal: ShaderModule = {
  code: /*wgsl*/ `
    // Compute water normal using finite differences
    fn computeWaterNormal(
      worldPos: vec2<f32>,
      time: f32,
      waveData: ptr<storage, array<f32>, read>,
      numWaves: i32,
      swellWaveCount: i32,
      steepness: f32,
      ampModSpatialScale: f32,
      ampModTimeScale: f32,
      ampModStrength: f32,
      waveSourceDirection: f32
    ) -> vec2<f32> {
      const SAMPLE_OFFSET: f32 = 1.0;

      // Sample amplitude modulation noise at center and offset positions
      let ampModTime = time * ampModTimeScale;

      let ampMod0 = 1.0 + simplex3D(vec3<f32>(
        worldPos.x * ampModSpatialScale,
        worldPos.y * ampModSpatialScale,
        ampModTime
      )) * ampModStrength;

      let ampModX = 1.0 + simplex3D(vec3<f32>(
        (worldPos.x + SAMPLE_OFFSET) * ampModSpatialScale,
        worldPos.y * ampModSpatialScale,
        ampModTime
      )) * ampModStrength;

      let ampModY = 1.0 + simplex3D(vec3<f32>(
        worldPos.x * ampModSpatialScale,
        (worldPos.y + SAMPLE_OFFSET) * ampModSpatialScale,
        ampModTime
      )) * ampModStrength;

      // Sample heights at center and offset positions
      let h0 = computeWaterHeightAtPoint(
        worldPos,
        time,
        waveData,
        numWaves,
        swellWaveCount,
        steepness,
        ampMod0,
        waveSourceDirection
      ).x;

      let hx = computeWaterHeightAtPoint(
        worldPos + vec2<f32>(SAMPLE_OFFSET, 0.0),
        time,
        waveData,
        numWaves,
        swellWaveCount,
        steepness,
        ampModX,
        waveSourceDirection
      ).x;

      let hy = computeWaterHeightAtPoint(
        worldPos + vec2<f32>(0.0, SAMPLE_OFFSET),
        time,
        waveData,
        numWaves,
        swellWaveCount,
        steepness,
        ampModY,
        waveSourceDirection
      ).x;

      // Compute gradient
      let dx = (hx - h0) / SAMPLE_OFFSET;
      let dy = (hy - h0) / SAMPLE_OFFSET;

      // Normal from gradient
      return normalize(vec2<f32>(-dx, -dy));
    }
  `,
  dependencies: [fn_simplex3D, fn_computeWaterHeightAtPoint],
};

/**
 * Main compute function for water queries.
 */
export const fn_computeWaterAtPoint: ShaderModule = {
  code: /*wgsl*/ `
    // Main compute function for water queries
    fn computeWaterAtPoint(
      worldPos: vec2<f32>,
      time: f32,
      tideHeight: f32,
      waveData: ptr<storage, array<f32>, read>,
      numWaves: i32,
      swellWaveCount: i32,
      steepness: f32,
      ampModSpatialScale: f32,
      ampModTimeScale: f32,
      ampModStrength: f32,
      waveSourceDirection: f32
    ) -> WaterResult {
      // Sample amplitude modulation noise
      let ampModTime = time * ampModTimeScale;
      let ampMod = 1.0 + simplex3D(vec3<f32>(
        worldPos.x * ampModSpatialScale,
        worldPos.y * ampModSpatialScale,
        ampModTime
      )) * ampModStrength;

      // Compute waves
      let waveResult = computeWaterHeightAtPoint(
        worldPos,
        time,
        waveData,
        numWaves,
        swellWaveCount,
        steepness,
        ampMod,
        waveSourceDirection
      );

      // Compute normal
      let normal = computeWaterNormal(
        worldPos,
        time,
        waveData,
        numWaves,
        swellWaveCount,
        steepness,
        ampModSpatialScale,
        ampModTimeScale,
        ampModStrength,
        waveSourceDirection
      );

      var result: WaterResult;
      result.surfaceHeight = waveResult.x + tideHeight;
      result.velocityX = 0.0; // No modifiers in v1
      result.velocityY = 0.0;
      result.normalX = normal.x;
      result.normalY = normal.y;
      result.dhdt = waveResult.w;

      return result;
    }
  `,
  dependencies: [
    struct_WaterResult,
    fn_simplex3D,
    fn_computeWaterHeightAtPoint,
    fn_computeWaterNormal,
  ],
};
