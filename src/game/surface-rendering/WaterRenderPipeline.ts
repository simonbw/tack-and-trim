/**
 * Water rendering compute pipeline.
 *
 * Uses the WaterStateShader for rendering.
 * Owns a single output texture (rgba32float) containing combined
 * wave + modifier data.
 *
 * Uses per-pixel influence texture sampling for terrain-aware waves.
 */

import {
  GPUProfiler,
  GPUProfileSection,
} from "../../core/graphics/webgpu/GPUProfiler";
import { getWebGPU } from "../../core/graphics/webgpu/WebGPUDevice";
import { profile } from "../../core/util/Profiler";
import type { InfluenceGridConfig } from "../world-data/influence/InfluenceFieldTypes";
import { WATER_TEXTURE_SIZE } from "./SurfaceRenderer";
import type { Viewport, WaterInfo } from "../world-data/water/WaterInfo";
import {
  WaterComputeBuffers,
  DEFAULT_MAX_FETCH,
} from "../world-data/water/webgpu/WaterComputeBuffers";
import { WaterStateShader } from "../world-data/water/webgpu/WaterStateShader";

/**
 * Influence texture configuration for water rendering.
 */
export interface RenderInfluenceConfig {
  swellTexture: GPUTexture;
  fetchTexture: GPUTexture;
  influenceSampler: GPUSampler;
  swellGridConfig: InfluenceGridConfig;
  fetchGridConfig: InfluenceGridConfig;
  waveSourceDirection: number;
}

/**
 * Water rendering compute pipeline using unified shader.
 */
export class WaterRenderPipeline {
  private shader: WaterStateShader | null = null;
  private buffers: WaterComputeBuffers | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private outputTexture: GPUTexture | null = null;
  private outputTextureView: GPUTextureView | null = null;
  private initialized = false;

  private textureSize: number;

  // Influence texture references
  private influenceConfig: RenderInfluenceConfig | null = null;

  constructor(textureSize: number = WATER_TEXTURE_SIZE) {
    this.textureSize = textureSize;
  }

  /**
   * Initialize WebGPU resources.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    const device = getWebGPU().device;

    // Initialize shared compute shader
    this.shader = new WaterStateShader();
    await this.shader.init();

    // Create shared buffers
    this.buffers = new WaterComputeBuffers();

    // Create output texture (owned by this pipeline)
    this.outputTexture = device.createTexture({
      size: { width: this.textureSize, height: this.textureSize },
      format: "rgba32float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      label: "Water Render Output Texture",
    });
    this.outputTextureView = this.outputTexture.createView();

    this.initialized = true;

    // Bind group will be created when influence textures are set
  }

  /**
   * Set influence textures for per-pixel terrain influence.
   * Must be called before update() to enable terrain-aware rendering.
   */
  setInfluenceTextures(config: RenderInfluenceConfig): void {
    this.influenceConfig = config;
    this.rebuildBindGroup();
  }

  /**
   * Rebuild the bind group with current textures.
   */
  private rebuildBindGroup(): void {
    if (
      !this.shader ||
      !this.buffers ||
      !this.outputTextureView ||
      !this.influenceConfig
    ) {
      return;
    }

    // Create bind group with all resources
    // Note: 3D textures need explicit dimension in createView()
    this.bindGroup = this.shader.createBindGroup({
      params: { buffer: this.buffers.paramsBuffer },
      waveData: { buffer: this.buffers.waveDataBuffer },
      segments: { buffer: this.buffers.segmentsBuffer },
      outputTexture: this.outputTextureView,
      swellTexture: this.influenceConfig.swellTexture.createView({
        dimension: "3d",
      }),
      fetchTexture: this.influenceConfig.fetchTexture.createView({
        dimension: "3d",
      }),
      influenceSampler: this.influenceConfig.influenceSampler,
    });
  }

  /**
   * Update water texture with current state for the given viewport.
   */
  @profile
  update(
    viewport: Viewport,
    waterInfo: WaterInfo,
    gpuProfiler?: GPUProfiler | null,
    section: GPUProfileSection = "waterCompute",
  ): void {
    if (
      !this.initialized ||
      !this.shader ||
      !this.buffers ||
      !this.bindGroup ||
      !this.influenceConfig
    ) {
      return;
    }

    const device = getWebGPU().device;

    // Get elapsed time
    const game = (waterInfo as { game?: { elapsedUnpausedTime?: number } })
      .game;
    const time = game?.elapsedUnpausedTime ?? 0;

    // Collect segment data from wake particles
    const segments = waterInfo.collectShaderSegmentData(viewport);
    const segmentCount = this.buffers.updateSegments(segments);

    const swellConfig = this.influenceConfig.swellGridConfig;
    const fetchConfig = this.influenceConfig.fetchGridConfig;

    // Update params buffer with grid config for per-pixel influence sampling
    this.buffers.updateParams({
      time,
      viewportLeft: viewport.left,
      viewportTop: viewport.top,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      textureSize: this.textureSize,
      segmentCount,
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
    });

    // Create command encoder
    const commandEncoder = device.createCommandEncoder({
      label: "Water Render Compute Encoder",
    });

    // Begin compute pass with optional timestamp writes
    const computePass = commandEncoder.beginComputePass({
      label: "Water Render Compute Pass",
      timestampWrites: gpuProfiler?.getComputeTimestampWrites(section),
    });

    this.shader.dispatch(computePass, this.bindGroup, this.textureSize);

    computePass.end();

    // Submit
    device.queue.submit([commandEncoder.finish()]);
  }

  /**
   * Get the output texture view for rendering.
   */
  getOutputTextureView(): GPUTextureView | null {
    return this.outputTextureView;
  }

  /**
   * Get the texture size.
   */
  getTextureSize(): number {
    return this.textureSize;
  }

  /**
   * Check if the pipeline is initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Check if influence textures are configured.
   */
  hasInfluenceTextures(): boolean {
    return this.influenceConfig !== null;
  }

  /**
   * Clean up GPU resources.
   */
  destroy(): void {
    this.buffers?.destroy();
    this.outputTexture?.destroy();
    this.shader?.destroy();
    this.bindGroup = null;
    this.outputTextureView = null;
    this.buffers = null;
    this.shader = null;
    this.initialized = false;
  }
}
