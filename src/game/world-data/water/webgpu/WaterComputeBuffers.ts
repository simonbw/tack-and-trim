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
  segmentCount: u32,
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
export const MAX_SEGMENTS = 256;
export const FLOATS_PER_SEGMENT = 12;

/** Default max fetch distance for normalization (~15km) */
export const DEFAULT_MAX_FETCH = 50000;

/**
 * Data for a single wake segment to be sent to GPU.
 */
export interface WakeSegmentData {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  startRadius: number;
  endRadius: number;
  startIntensity: number;
  endIntensity: number;
  startVelX: number;
  startVelY: number;
  endVelX: number;
  endVelY: number;
}

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
  segmentCount: number;
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
  readonly segmentsBuffer: GPUBuffer;

  private params!: UniformInstance<typeof WaterParams.fields>;
  private segmentData: Float32Array;

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

    // Create segments storage buffer
    this.segmentData = new Float32Array(MAX_SEGMENTS * FLOATS_PER_SEGMENT);
    this.segmentsBuffer = device.createBuffer({
      size: this.segmentData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: "Water Segments Buffer",
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
    this.params.set.segmentCount(input.segmentCount);

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
   * Update the segments buffer with wake segment data.
   * Returns the actual number of segments uploaded.
   */
  updateSegments(segments: WakeSegmentData[]): number {
    const device = getWebGPU().device;
    const segmentCount = Math.min(segments.length, MAX_SEGMENTS);

    for (let i = 0; i < segmentCount; i++) {
      const seg = segments[i];
      const base = i * FLOATS_PER_SEGMENT;
      this.segmentData[base + 0] = seg.startX;
      this.segmentData[base + 1] = seg.startY;
      this.segmentData[base + 2] = seg.endX;
      this.segmentData[base + 3] = seg.endY;
      this.segmentData[base + 4] = seg.startRadius;
      this.segmentData[base + 5] = seg.endRadius;
      this.segmentData[base + 6] = seg.startIntensity;
      this.segmentData[base + 7] = seg.endIntensity;
      this.segmentData[base + 8] = seg.startVelX;
      this.segmentData[base + 9] = seg.startVelY;
      this.segmentData[base + 10] = seg.endVelX;
      this.segmentData[base + 11] = seg.endVelY;
    }

    // Only upload the portion we need
    if (segmentCount > 0) {
      const uploadSize = segmentCount * FLOATS_PER_SEGMENT * 4;
      device.queue.writeBuffer(
        this.segmentsBuffer,
        0,
        this.segmentData.buffer,
        0,
        uploadSize,
      );
    }

    return segmentCount;
  }

  /**
   * Clean up GPU resources.
   */
  destroy(): void {
    this.waveDataBuffer.destroy();
    this.paramsBuffer.destroy();
    this.segmentsBuffer.destroy();
  }
}
