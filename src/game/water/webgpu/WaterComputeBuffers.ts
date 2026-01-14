/**
 * Shared buffer management for water compute shaders.
 *
 * Provides consistent buffer creation and updates for both
 * the rendering pipeline and physics tile pipeline.
 */

import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import { buildWaveDataArray } from "../WaterConstants";

// Constants for modifier computation
export const MAX_SEGMENTS = 256;
export const FLOATS_PER_SEGMENT = 12;

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
  textureSize: number;
  segmentCount: number;
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

    // Create params uniform buffer (32 bytes)
    // Layout: time, viewportLeft, viewportTop, viewportWidth, viewportHeight,
    //         textureSizeX, textureSizeY, segmentCount
    this.paramsBuffer = device.createBuffer({
      size: 32,
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
  updateParams(params: WaterComputeParams): void {
    const device = getWebGPU().device;

    const paramsData = new ArrayBuffer(32);
    const paramsFloats = new Float32Array(paramsData, 0, 7);
    const paramsUints = new Uint32Array(paramsData, 28, 1);

    paramsFloats[0] = params.time;
    paramsFloats[1] = params.viewportLeft;
    paramsFloats[2] = params.viewportTop;
    paramsFloats[3] = params.viewportWidth;
    paramsFloats[4] = params.viewportHeight;
    paramsFloats[5] = params.textureSize;
    paramsFloats[6] = params.textureSize;
    paramsUints[0] = params.segmentCount;

    device.queue.writeBuffer(this.paramsBuffer, 0, paramsData);
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
        uploadSize
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
