/**
 * Water physics tile compute implementation.
 *
 * Uses the WaterStateShader for tile-based physics queries.
 * Each instance owns its output texture; the shader and buffer management
 * are shared via WaterStateShader and WaterComputeBuffers.
 *
 * Implements DataTileCompute interface for use with DataTileComputePipeline.
 */

import { getWebGPU } from "../../../../core/graphics/webgpu/WebGPUDevice";
import type { DataTileCompute } from "../../datatiles/DataTileComputePipeline";
import {
  WaterComputeBuffers,
  type WakeSegmentData,
} from "./WaterComputeBuffers";
import { WaterStateShader } from "./WaterStateShader";

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
  private shader: WaterStateShader;
  private buffers: WaterComputeBuffers | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private outputTexture: GPUTexture | null = null;

  private textureSize: number;
  private currentSegmentCount: number = 0;

  // Terrain influence factors
  private swellEnergyFactor: number = 1.0;
  private chopEnergyFactor: number = 1.0;
  private fetchFactor: number = 1.0;

  constructor(textureSize: number = 128) {
    this.textureSize = textureSize;
    this.shader = new WaterStateShader();
  }

  /**
   * Initialize WebGPU resources.
   */
  async init(): Promise<void> {
    const device = getWebGPU().device;

    // Initialize shared compute shader
    await this.shader.init();

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

    // Create bind group using type-safe shader method
    this.bindGroup = this.shader.createBindGroup({
      params: { buffer: this.buffers.paramsBuffer },
      waveData: { buffer: this.buffers.waveDataBuffer },
      segments: { buffer: this.buffers.segmentsBuffer },
      outputTexture: this.outputTexture.createView(),
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
   * Set terrain influence factors for wave computation.
   * @param swellEnergy 0-1 factor for long swell waves (terrain diffraction)
   * @param chopEnergy 0-1 factor for short chop waves (terrain shadow)
   * @param fetchFactor 0-1 factor based on fetch distance
   */
  setWaveInfluence(
    swellEnergy: number,
    chopEnergy: number,
    fetchFactor: number,
  ): void {
    this.swellEnergyFactor = swellEnergy;
    this.chopEnergyFactor = chopEnergy;
    this.fetchFactor = fetchFactor;
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
      swellEnergyFactor: this.swellEnergyFactor,
      chopEnergyFactor: this.chopEnergyFactor,
      fetchFactor: this.fetchFactor,
    });

    // Create and submit compute pass
    const commandEncoder = device.createCommandEncoder({
      label: "Water Physics Tile Compute Encoder",
    });

    const computePass = commandEncoder.beginComputePass({
      label: "Water Physics Tile Compute Pass",
    });

    this.shader.dispatch(computePass, this.bindGroup, this.textureSize);

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
    this.shader.destroy();
    this.bindGroup = null;
    this.buffers = null;
  }
}
