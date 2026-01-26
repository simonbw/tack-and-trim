/**
 * Analytical Water Physics Tile Compute
 *
 * Uses the AnalyticalWaterStateShader with texture-based shadow system
 * for per-pixel wave physics computation.
 *
 * Key differences from WaterDataTileCompute:
 * - Uses shadow texture + data buffer instead of 3D influence textures
 * - Integrates with WavePhysicsManager for shadow data
 */

import { getWebGPU } from "../../../../core/graphics/webgpu/WebGPUDevice";
import type { UniformInstance } from "../../../../core/graphics/UniformStruct";
import type { DepthGridConfig } from "../../influence/InfluenceFieldTypes";
import type { DataTileCompute } from "../../datatiles/DataTileComputePipeline";
import {
  WaterComputeBuffers,
  type WakeSegmentData,
} from "./WaterComputeBuffers";
import { AnalyticalWaterStateShader } from "./AnalyticalWaterStateShader";
import { AnalyticalWaterParams } from "./AnalyticalWaterParams";

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
 * Configuration for analytical water compute.
 */
export interface AnalyticalWaterConfig {
  depthTexture: GPUTexture;
  depthSampler: GPUSampler;
  depthGridConfig: DepthGridConfig;
  waveSourceDirection: number;
}

/**
 * Shadow resources for analytical water compute.
 */
export interface ShadowResources {
  shadowTextureView: GPUTextureView;
  shadowDataBuffer: GPUBuffer;
}

/**
 * Analytical water physics tile compute.
 */
export class AnalyticalWaterDataTileCompute implements DataTileCompute {
  private shader: AnalyticalWaterStateShader;
  private buffers: WaterComputeBuffers | null = null;
  private paramsBuffer: GPUBuffer | null = null;
  private params: UniformInstance<typeof AnalyticalWaterParams.fields> | null =
    null;
  private bindGroup: GPUBindGroup | null = null;
  private outputTexture: GPUTexture | null = null;

  private textureSize: number;
  private currentSegmentCount: number = 0;
  private currentTideHeight: number = 0;

  // Configuration
  private config: AnalyticalWaterConfig | null = null;
  private shadowResources: ShadowResources | null = null;

  constructor(textureSize: number = 128) {
    this.textureSize = textureSize;
    this.shader = new AnalyticalWaterStateShader();
  }

  /**
   * Initialize WebGPU resources.
   */
  async init(): Promise<void> {
    const device = getWebGPU().device;

    // Initialize compute shader
    await this.shader.init();

    // Create shared buffers (for wave data and segments)
    this.buffers = new WaterComputeBuffers();

    // Create params buffer specific to analytical water shader
    this.paramsBuffer = device.createBuffer({
      size: AnalyticalWaterParams.byteSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Analytical Water Params Buffer",
    });
    this.params = AnalyticalWaterParams.create();

    // Create output texture
    this.outputTexture = device.createTexture({
      size: { width: this.textureSize, height: this.textureSize },
      format: "rgba32float",
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
      label: "Analytical Water Physics Tile Output Texture",
    });
  }

  /**
   * Set the configuration for analytical water compute.
   */
  setConfig(config: AnalyticalWaterConfig): void {
    this.config = config;
    this.rebuildBindGroup();
  }

  /**
   * Set shadow resources from WavePhysicsManager.
   */
  setShadowResources(resources: ShadowResources): void {
    this.shadowResources = resources;
    this.rebuildBindGroup();
  }

  /**
   * Rebuild the bind group with current resources.
   */
  private rebuildBindGroup(): void {
    if (
      !this.buffers ||
      !this.paramsBuffer ||
      !this.outputTexture ||
      !this.config ||
      !this.shadowResources
    ) {
      return;
    }

    // Create bind group with shadow texture and data buffer
    this.bindGroup = this.shader.createBindGroup({
      params: { buffer: this.paramsBuffer },
      waveData: { buffer: this.buffers.waveDataBuffer },
      segments: { buffer: this.buffers.segmentsBuffer },
      outputTexture: this.outputTexture.createView(),
      depthTexture: this.config.depthTexture.createView({ dimension: "2d" }),
      depthSampler: this.config.depthSampler,
      shadowTexture: this.shadowResources.shadowTextureView,
      shadowData: { buffer: this.shadowResources.shadowDataBuffer },
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
   * Set tide height for this compute pass.
   */
  setTideHeight(tideHeight: number): void {
    this.currentTideHeight = tideHeight;
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
    if (
      !this.buffers ||
      !this.paramsBuffer ||
      !this.params ||
      !this.bindGroup ||
      !this.config
    ) {
      return;
    }

    const device = getWebGPU().device;
    const depthConfig = this.config.depthGridConfig;

    // Update params buffer using type-safe setters
    this.params.set.time(time);
    this.params.set.viewportLeft(left);
    this.params.set.viewportTop(top);
    this.params.set.viewportWidth(width);
    this.params.set.viewportHeight(height);
    this.params.set.textureSizeX(this.textureSize);
    this.params.set.textureSizeY(this.textureSize);
    this.params.set.segmentCount(this.currentSegmentCount);
    this.params.set.depthOriginX(depthConfig.originX);
    this.params.set.depthOriginY(depthConfig.originY);
    this.params.set.depthGridWidth(depthConfig.cellsX * depthConfig.cellSize);
    this.params.set.depthGridHeight(depthConfig.cellsY * depthConfig.cellSize);
    this.params.set.waveSourceDirection(this.config.waveSourceDirection);
    this.params.set.tideHeight(this.currentTideHeight);
    this.params.set._padding1(0);
    this.params.set._padding2(0);

    // Upload to GPU
    this.params.uploadTo(this.paramsBuffer);

    // Create and submit compute pass
    const commandEncoder = device.createCommandEncoder({
      label: "Analytical Water Physics Tile Compute Encoder",
    });

    const computePass = commandEncoder.beginComputePass({
      label: "Analytical Water Physics Tile Compute Pass",
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
    this.paramsBuffer?.destroy();
    this.outputTexture?.destroy();
    this.shader.destroy();
    this.bindGroup = null;
    this.buffers = null;
    this.paramsBuffer = null;
  }
}
