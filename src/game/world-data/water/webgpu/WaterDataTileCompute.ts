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
import type {
  DepthGridConfig,
  InfluenceGridConfig,
} from "../../influence/InfluenceFieldTypes";
import type { DataTileCompute } from "../../datatiles/DataTileComputePipeline";
import {
  WaterComputeBuffers,
  DEFAULT_MAX_FETCH,
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
 * Influence texture configuration for water compute.
 */
export interface InfluenceTextureConfig {
  swellTexture: GPUTexture;
  fetchTexture: GPUTexture;
  depthTexture: GPUTexture;
  influenceSampler: GPUSampler;
  swellGridConfig: InfluenceGridConfig;
  fetchGridConfig: InfluenceGridConfig;
  depthGridConfig: DepthGridConfig;
  waveSourceDirection: number;
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
  private currentTideHeight: number = 0;

  // Influence texture references
  private influenceConfig: InfluenceTextureConfig | null = null;

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

    // Bind group will be created when influence textures are set
  }

  /**
   * Set influence textures for per-pixel terrain influence.
   * Must be called before runCompute.
   */
  setInfluenceTextures(config: InfluenceTextureConfig): void {
    this.influenceConfig = config;
    this.rebuildBindGroup();
  }

  /**
   * Rebuild the bind group with current textures.
   */
  private rebuildBindGroup(): void {
    if (!this.buffers || !this.outputTexture || !this.influenceConfig) {
      return;
    }

    // Create bind group with all resources
    // Note: 3D textures need explicit dimension in createView()
    this.bindGroup = this.shader.createBindGroup({
      params: { buffer: this.buffers.paramsBuffer },
      waveData: { buffer: this.buffers.waveDataBuffer },
      segments: { buffer: this.buffers.segmentsBuffer },
      outputTexture: this.outputTexture.createView(),
      swellTexture: this.influenceConfig.swellTexture.createView({
        dimension: "3d",
      }),
      fetchTexture: this.influenceConfig.fetchTexture.createView({
        dimension: "3d",
      }),
      influenceSampler: this.influenceConfig.influenceSampler,
      depthTexture: this.influenceConfig.depthTexture.createView({
        dimension: "2d",
      }),
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
    if (!this.buffers || !this.bindGroup || !this.influenceConfig) {
      return;
    }

    const device = getWebGPU().device;
    const swellConfig = this.influenceConfig.swellGridConfig;
    const fetchConfig = this.influenceConfig.fetchGridConfig;
    const depthConfig = this.influenceConfig.depthGridConfig;

    // Update params buffer with grid config
    this.buffers.updateParams({
      time,
      viewportLeft: left,
      viewportTop: top,
      viewportWidth: width,
      viewportHeight: height,
      textureSizeX: this.textureSize,
      textureSizeY: this.textureSize,
      segmentCount: this.currentSegmentCount,
      // Swell grid config
      swellOriginX: swellConfig.originX,
      swellOriginY: swellConfig.originY,
      swellGridWidth: swellConfig.cellsX * swellConfig.cellSize,
      swellGridHeight: swellConfig.cellsY * swellConfig.cellSize,
      swellDirectionCount: swellConfig.directionCount,
      // Fetch grid config
      fetchOriginX: fetchConfig.originX,
      fetchOriginY: fetchConfig.originY,
      fetchGridWidth: fetchConfig.cellsX * fetchConfig.cellSize,
      fetchGridHeight: fetchConfig.cellsY * fetchConfig.cellSize,
      fetchDirectionCount: fetchConfig.directionCount,
      // Max fetch and wave source direction
      maxFetch: DEFAULT_MAX_FETCH,
      waveSourceDirection: this.influenceConfig.waveSourceDirection,
      // Tide height
      tideHeight: this.currentTideHeight,
      // Depth grid config
      depthOriginX: depthConfig.originX,
      depthOriginY: depthConfig.originY,
      depthGridWidth: depthConfig.cellsX * depthConfig.cellSize,
      depthGridHeight: depthConfig.cellsY * depthConfig.cellSize,
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
