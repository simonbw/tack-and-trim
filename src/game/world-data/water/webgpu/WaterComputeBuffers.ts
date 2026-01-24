/**
 * Shared buffer management for water compute shaders.
 *
 * Provides consistent buffer creation and updates for both
 * the rendering pipeline and physics tile pipeline.
 */

import { getWebGPU } from "../../../../core/graphics/webgpu/WebGPUDevice";
import { buildWaveDataArray } from "../WaterConstants";

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
  textureSize: number;
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

    // Create params uniform buffer (144 bytes for new layout)
    // Layout matches Params struct in shader:
    //   time, viewportLeft, viewportTop, viewportWidth, viewportHeight (20 bytes)
    //   textureSizeX, textureSizeY, segmentCount (12 bytes)
    //   swellOriginX, swellOriginY, swellGridWidth, swellGridHeight, swellDirectionCount (20 bytes)
    //   fetchOriginX, fetchOriginY, fetchGridWidth, fetchGridHeight, fetchDirectionCount (20 bytes)
    //   maxFetch, waveSourceDirection, tideHeight (12 bytes)
    //   depthOriginX, depthOriginY, depthGridWidth, depthGridHeight (16 bytes)
    //   padding to 144 bytes for 16-byte alignment
    this.paramsBuffer = device.createBuffer({
      size: 144,
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

    const paramsData = new ArrayBuffer(144);
    const floats = new Float32Array(paramsData);
    const uints = new Uint32Array(paramsData);

    // Basic params (0-7)
    floats[0] = params.time;
    floats[1] = params.viewportLeft;
    floats[2] = params.viewportTop;
    floats[3] = params.viewportWidth;
    floats[4] = params.viewportHeight;
    floats[5] = params.textureSize;
    floats[6] = params.textureSize;
    uints[7] = params.segmentCount;

    // Swell grid config (8-12)
    floats[8] = params.swellOriginX;
    floats[9] = params.swellOriginY;
    floats[10] = params.swellGridWidth;
    floats[11] = params.swellGridHeight;
    floats[12] = params.swellDirectionCount;

    // Fetch grid config (13-17)
    floats[13] = params.fetchOriginX;
    floats[14] = params.fetchOriginY;
    floats[15] = params.fetchGridWidth;
    floats[16] = params.fetchGridHeight;
    floats[17] = params.fetchDirectionCount;

    // Max fetch and wave source direction (18-19)
    floats[18] = params.maxFetch;
    floats[19] = params.waveSourceDirection;

    // Tide height (20)
    floats[20] = params.tideHeight;

    // Depth grid config (21-24)
    floats[21] = params.depthOriginX;
    floats[22] = params.depthOriginY;
    floats[23] = params.depthGridWidth;
    floats[24] = params.depthGridHeight;

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
