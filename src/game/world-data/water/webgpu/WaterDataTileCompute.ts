/**
 * Water physics tile compute implementation.
 *
 * Uses the unified WaterStateCompute shader for tile-based physics queries.
 * Each instance owns its output texture; the shader and buffer management
 * are shared via WaterStateCompute and WaterComputeBuffers.
 *
 * Implements DataTileCompute interface for use with DataTileComputePipeline.
 */

import { getWebGPU } from "../../../../core/graphics/webgpu/WebGPUDevice";
import type { DataTileCompute } from "../../datatiles/DataTileComputePipeline";
import {
  WaterComputeBuffers,
  type WakeSegmentData,
} from "./WaterComputeBuffers";
import { WaterStateCompute } from "./WaterStateCompute";

/**
 * Water physics data sample type.
 */
export interface WaterPointData {
  height: number;
  dhdt: number;
  velocityX: number;
  velocityY: number;
}

/**
 * Water physics tile compute using shared shader infrastructure.
 * Implements DataTileCompute interface for use with DataTileComputePipeline.
 */
export class WaterDataTileCompute implements DataTileCompute {
  private stateCompute: WaterStateCompute;
  private buffers: WaterComputeBuffers | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private outputTexture: GPUTexture | null = null;

  private textureSize: number;
  private currentSegmentCount: number = 0;

  constructor(textureSize: number = 128) {
    this.textureSize = textureSize;
    this.stateCompute = new WaterStateCompute();
  }

  /**
   * Initialize WebGPU resources.
   */
  async init(): Promise<void> {
    const device = getWebGPU().device;

    // Initialize shared compute shader
    await this.stateCompute.init();

    // Create shared buffers
    this.buffers = new WaterComputeBuffers();

    // Create output texture (owned by this tile compute instance)
    this.outputTexture = device.createTexture({
      size: { width: this.textureSize, height: this.textureSize },
      format: "rgba32float",
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
      label: "Water Physics Tile Output Texture",
    });

    // Create bind group using shared layout
    this.bindGroup = device.createBindGroup({
      layout: this.stateCompute.getBindGroupLayout(),
      entries: [
        { binding: 0, resource: { buffer: this.buffers.paramsBuffer } },
        { binding: 1, resource: { buffer: this.buffers.waveDataBuffer } },
        { binding: 2, resource: { buffer: this.buffers.segmentsBuffer } },
        { binding: 3, resource: this.outputTexture.createView() },
      ],
      label: "Water Physics Tile Bind Group",
    });
  }

  /**
   * Set wake segment data for modifier computation.
   */
  setSegments(segments: WakeSegmentData[]): void {
    if (!this.buffers) return;
    this.currentSegmentCount = this.buffers.updateSegments(segments);
  }

  /**
   * Run the compute shader for a tile viewport.
   */
  runCompute(
    time: number,
    left: number,
    top: number,
    width: number,
    height: number,
  ): void {
    if (!this.buffers || !this.bindGroup) {
      return;
    }

    const device = getWebGPU().device;

    // Update params buffer
    this.buffers.updateParams({
      time,
      viewportLeft: left,
      viewportTop: top,
      viewportWidth: width,
      viewportHeight: height,
      textureSize: this.textureSize,
      segmentCount: this.currentSegmentCount,
    });

    // Create and submit compute pass
    const commandEncoder = device.createCommandEncoder({
      label: "Water Physics Tile Compute Encoder",
    });

    const computePass = commandEncoder.beginComputePass({
      label: "Water Physics Tile Compute Pass",
    });

    this.stateCompute.dispatch(computePass, this.bindGroup, this.textureSize);

    computePass.end();

    device.queue.submit([commandEncoder.finish()]);
  }

  /**
   * Get the output texture for readback.
   */
  getOutputTexture(): GPUTexture | null {
    return this.outputTexture;
  }

  /**
   * Clean up GPU resources.
   */
  destroy(): void {
    this.buffers?.destroy();
    this.outputTexture?.destroy();
    this.stateCompute.destroy();
    this.bindGroup = null;
    this.buffers = null;
  }
}
