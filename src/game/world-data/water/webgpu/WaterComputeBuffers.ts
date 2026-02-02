/**
 * Shared buffer management for water compute shaders.
 *
 * Provides consistent buffer creation and updates for both
 * the rendering pipeline and physics tile pipeline.
 */

import { getWebGPU } from "../../../../core/graphics/webgpu/WebGPUDevice";
import {
  defineUniformStruct,
  f32,
  u32,
  type UniformInstance,
} from "../../../../core/graphics/UniformStruct";
import { buildWaveDataArray } from "../WaterConstants";
import type { GPUWaterModifierData } from "../WaterModifierBase";
import { WaterModifierType } from "../WaterModifierBase";

// Type-safe params buffer definition - single source of truth for shader struct
export const WaterParams = defineUniformStruct("Params", {
  // Basic params
  time: f32,
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  textureSizeX: f32,
  textureSizeY: f32,
  modifierCount: u32,
  // Swell grid config
  swellOriginX: f32,
  swellOriginY: f32,
  swellGridWidth: f32,
  swellGridHeight: f32,
  swellDirectionCount: f32,
  // Fetch grid config
  fetchOriginX: f32,
  fetchOriginY: f32,
  fetchGridWidth: f32,
  fetchGridHeight: f32,
  fetchDirectionCount: f32,
  // Max fetch and wave source direction
  maxFetch: f32,
  waveSourceDirection: f32,
  // Tide height
  tideHeight: f32,
  // Depth grid config
  depthOriginX: f32,
  depthOriginY: f32,
  depthGridWidth: f32,
  depthGridHeight: f32,
  // Padding to 112 bytes (28 floats) - WGSL rounds up to multiple of max align
  _padding1: f32,
  _padding2: f32,
  _padding3: f32,
});

// Constants for modifier computation
export const MAX_MODIFIERS = 16384;
export const FLOATS_PER_MODIFIER = 8;

/** Default max fetch distance for normalization (~15km) */
export const DEFAULT_MAX_FETCH = 50000;

/**
 * Parameters for water compute shader.
 */
export interface WaterComputeParams {
  time: number;
  viewportLeft: number;
  viewportTop: number;
  viewportWidth: number;
  viewportHeight: number;
  textureSizeX: number;
  textureSizeY: number;
  modifierCount: number;
  // Swell influence grid config
  swellOriginX: number;
  swellOriginY: number;
  swellGridWidth: number;
  swellGridHeight: number;
  swellDirectionCount: number;
  // Fetch influence grid config
  fetchOriginX: number;
  fetchOriginY: number;
  fetchGridWidth: number;
  fetchGridHeight: number;
  fetchDirectionCount: number;
  // Max fetch for normalization
  maxFetch: number;
  // Wave source direction (for texture lookup)
  waveSourceDirection: number;
  // Tide height offset
  tideHeight: number;
  // Depth grid config (for shoaling/damping)
  depthOriginX: number;
  depthOriginY: number;
  depthGridWidth: number;
  depthGridHeight: number;
}

/**
 * Shared buffer management for water compute shaders.
 *
 * Both the rendering pipeline and physics tile pipeline use this
 * to ensure consistent data provision to the GPU shader.
 */
export class WaterComputeBuffers {
  readonly waveDataBuffer: GPUBuffer;
  readonly paramsBuffer: GPUBuffer;
  readonly modifiersBuffer: GPUBuffer;

  private params!: UniformInstance<typeof WaterParams.fields>;
  private modifierData: Float32Array;

  constructor() {
    const device = getWebGPU().device;

    // Create wave data storage buffer (static, uploaded once)
    const waveData = buildWaveDataArray();
    this.waveDataBuffer = device.createBuffer({
      size: waveData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: "Water Wave Data Buffer",
      mappedAtCreation: true,
    });
    new Float32Array(this.waveDataBuffer.getMappedRange()).set(waveData);
    this.waveDataBuffer.unmap();

    // Create type-safe params instance
    this.params = WaterParams.create();

    // Create params uniform buffer
    this.paramsBuffer = device.createBuffer({
      size: WaterParams.byteSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Water Params Buffer",
    });

    // Create modifiers storage buffer
    this.modifierData = new Float32Array(MAX_MODIFIERS * FLOATS_PER_MODIFIER);
    this.modifiersBuffer = device.createBuffer({
      size: this.modifierData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: "Water Modifiers Buffer",
    });
  }

  /**
   * Update the params buffer with current frame data.
   */
  updateParams(input: WaterComputeParams): void {
    // Use type-safe setters
    this.params.set.time(input.time);
    this.params.set.viewportLeft(input.viewportLeft);
    this.params.set.viewportTop(input.viewportTop);
    this.params.set.viewportWidth(input.viewportWidth);
    this.params.set.viewportHeight(input.viewportHeight);
    this.params.set.textureSizeX(input.textureSizeX);
    this.params.set.textureSizeY(input.textureSizeY);
    this.params.set.modifierCount(input.modifierCount);

    // Swell grid config
    this.params.set.swellOriginX(input.swellOriginX);
    this.params.set.swellOriginY(input.swellOriginY);
    this.params.set.swellGridWidth(input.swellGridWidth);
    this.params.set.swellGridHeight(input.swellGridHeight);
    this.params.set.swellDirectionCount(input.swellDirectionCount);

    // Fetch grid config
    this.params.set.fetchOriginX(input.fetchOriginX);
    this.params.set.fetchOriginY(input.fetchOriginY);
    this.params.set.fetchGridWidth(input.fetchGridWidth);
    this.params.set.fetchGridHeight(input.fetchGridHeight);
    this.params.set.fetchDirectionCount(input.fetchDirectionCount);

    // Max fetch and wave source direction
    this.params.set.maxFetch(input.maxFetch);
    this.params.set.waveSourceDirection(input.waveSourceDirection);

    // Tide height
    this.params.set.tideHeight(input.tideHeight);

    // Depth grid config
    this.params.set.depthOriginX(input.depthOriginX);
    this.params.set.depthOriginY(input.depthOriginY);
    this.params.set.depthGridWidth(input.depthGridWidth);
    this.params.set.depthGridHeight(input.depthGridHeight);

    // Padding
    this.params.set._padding1(0);
    this.params.set._padding2(0);
    this.params.set._padding3(0);

    // Upload to GPU
    this.params.uploadTo(this.paramsBuffer);
  }

  /**
   * Update the modifiers buffer with water modifier data.
   * Returns the actual number of modifiers uploaded.
   */
  updateModifiers(modifiers: GPUWaterModifierData[]): number {
    const device = getWebGPU().device;
    const modifierCount = Math.min(modifiers.length, MAX_MODIFIERS);

    for (let i = 0; i < modifierCount; i++) {
      const mod = modifiers[i];
      const base = i * FLOATS_PER_MODIFIER;

      // Header: type + bounds (AABB)
      this.modifierData[base + 0] = mod.type;
      this.modifierData[base + 1] = mod.bounds.lowerBound.x;
      this.modifierData[base + 2] = mod.bounds.lowerBound.y;
      this.modifierData[base + 3] = mod.bounds.upperBound.x;
      this.modifierData[base + 4] = mod.bounds.upperBound.y;

      // Pack type-specific data into [5-7]
      switch (mod.data.type) {
        case WaterModifierType.Wake:
          this.modifierData[base + 5] = mod.data.intensity;
          this.modifierData[base + 6] = mod.data.velocityX;
          this.modifierData[base + 7] = mod.data.velocityY;
          break;
        case WaterModifierType.Ripple:
          this.modifierData[base + 5] = mod.data.radius;
          this.modifierData[base + 6] = mod.data.intensity;
          this.modifierData[base + 7] = mod.data.phase;
          break;
        case WaterModifierType.Current:
          this.modifierData[base + 5] = mod.data.velocityX;
          this.modifierData[base + 6] = mod.data.velocityY;
          this.modifierData[base + 7] = mod.data.fadeDistance;
          break;
        case WaterModifierType.Obstacle:
          this.modifierData[base + 5] = mod.data.dampingFactor;
          this.modifierData[base + 6] = mod.data.padding1;
          this.modifierData[base + 7] = mod.data.padding2;
          break;
      }
    }

    // Only upload the portion we need
    if (modifierCount > 0) {
      const uploadSize = modifierCount * FLOATS_PER_MODIFIER * 4;
      device.queue.writeBuffer(
        this.modifiersBuffer,
        0,
        this.modifierData.buffer,
        0,
        uploadSize,
      );
    }

    return modifierCount;
  }

  /**
   * Clean up GPU resources.
   */
  destroy(): void {
    this.waveDataBuffer.destroy();
    this.paramsBuffer.destroy();
    this.modifiersBuffer.destroy();
  }
}
