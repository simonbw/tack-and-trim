/**
 * Water rendering compute pipeline.
 *
 * Uses the WaterStateShader for rendering.
 * Owns a single output texture (rgba32float) containing combined
 * wave + modifier data.
 *
 * Uses per-pixel influence texture sampling for terrain-aware waves.
 * When influence textures are not provided, uses placeholder textures
 * that provide uniform full swell and fetch values.
 */

import {
  GPUProfiler,
  GPUProfileSection,
} from "../../core/graphics/webgpu/GPUProfiler";
import { getWebGPU } from "../../core/graphics/webgpu/WebGPUDevice";
import { profile } from "../../core/util/Profiler";
import { TimeOfDay } from "../time/TimeOfDay";
import type {
  DepthGridConfig,
  InfluenceGridConfig,
} from "../world-data/influence/InfluenceFieldTypes";
import { WATER_TEXTURE_SIZE } from "./SurfaceRenderer";
import type { Viewport, WaterInfo } from "../world-data/water/WaterInfo";
import {
  WaterComputeBuffers,
  DEFAULT_MAX_FETCH,
} from "../world-data/water/webgpu/WaterComputeBuffers";
import { WaterStateShader } from "../world-data/water/webgpu/WaterStateShader";

// Default grid config for fallback influence textures
const FALLBACK_GRID_CONFIG: InfluenceGridConfig = {
  originX: -10000,
  originY: -10000,
  cellSize: 100,
  cellsX: 200,
  cellsY: 200,
  directionCount: 8,
};

// Default depth grid config for fallback depth texture
const FALLBACK_DEPTH_CONFIG: DepthGridConfig = {
  originX: -10000,
  originY: -10000,
  cellSize: 100,
  cellsX: 1,
  cellsY: 1,
};

/**
 * Influence texture configuration for water rendering.
 */
export interface RenderInfluenceConfig {
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

  // Fallback influence textures (used when no influence config provided)
  private fallbackSwellTexture: GPUTexture | null = null;
  private fallbackFetchTexture: GPUTexture | null = null;
  private fallbackDepthTexture: GPUTexture | null = null;
  private fallbackSampler: GPUSampler | null = null;
  private fallbackConfig: RenderInfluenceConfig | null = null;

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

    // Create fallback influence textures for when no influence manager is available
    this.createFallbackInfluenceTextures();

    this.initialized = true;

    // Bind group will be created when influence textures are set or when using fallbacks
  }

  /**
   * Create fallback influence textures that provide uniform full swell/fetch values.
   * Used when no InfluenceFieldManager is available (e.g., in the editor).
   */
  private createFallbackInfluenceTextures(): void {
    const device = getWebGPU().device;

    // Create 1x1x1 3D textures with full values
    // Swell texture: RGBA = (longEnergy=1, longDir=0, shortEnergy=1, shortDir=0)
    this.fallbackSwellTexture = device.createTexture({
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      format: "rgba32float",
      dimension: "3d",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      label: "Fallback Swell Texture",
    });

    // Full swell energy (1.0), no direction offset (0.0)
    device.queue.writeTexture(
      { texture: this.fallbackSwellTexture },
      new Float32Array([1.0, 0.0, 1.0, 0.0]),
      { bytesPerRow: 16 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );

    // Fetch texture: R = max fetch distance
    this.fallbackFetchTexture = device.createTexture({
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      format: "rgba32float",
      dimension: "3d",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      label: "Fallback Fetch Texture",
    });

    // Full fetch distance
    device.queue.writeTexture(
      { texture: this.fallbackFetchTexture },
      new Float32Array([DEFAULT_MAX_FETCH, 0.0, 0.0, 0.0]),
      { bytesPerRow: 16 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );

    // Depth texture: R = -100 (deep water) for fallback (no shoaling effect)
    this.fallbackDepthTexture = device.createTexture({
      size: { width: 1, height: 1 },
      format: "r32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      label: "Fallback Depth Texture",
    });

    // Deep water (no shoaling)
    device.queue.writeTexture(
      { texture: this.fallbackDepthTexture },
      new Float32Array([-100.0]),
      { bytesPerRow: 4 },
      { width: 1, height: 1 },
    );

    // Create sampler for fallback textures
    this.fallbackSampler = device.createSampler({
      magFilter: "nearest",
      minFilter: "nearest",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
      addressModeW: "clamp-to-edge",
    });

    // Create fallback config
    this.fallbackConfig = {
      swellTexture: this.fallbackSwellTexture,
      fetchTexture: this.fallbackFetchTexture,
      depthTexture: this.fallbackDepthTexture,
      influenceSampler: this.fallbackSampler,
      swellGridConfig: FALLBACK_GRID_CONFIG,
      fetchGridConfig: FALLBACK_GRID_CONFIG,
      depthGridConfig: FALLBACK_DEPTH_CONFIG,
      waveSourceDirection: 0,
    };
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
   * Uses fallback textures if no influence config is set.
   */
  private rebuildBindGroup(): void {
    if (!this.shader || !this.buffers || !this.outputTextureView) {
      return;
    }

    // Use provided config or fallback (fallback is always created in init)
    const config = this.influenceConfig ?? this.fallbackConfig!;

    // Create bind group with all resources
    // Note: 3D textures need explicit dimension in createView()
    this.bindGroup = this.shader.createBindGroup({
      params: { buffer: this.buffers.paramsBuffer },
      waveData: { buffer: this.buffers.waveDataBuffer },
      segments: { buffer: this.buffers.segmentsBuffer },
      outputTexture: this.outputTextureView,
      swellTexture: config.swellTexture.createView({
        dimension: "3d",
      }),
      fetchTexture: config.fetchTexture.createView({
        dimension: "3d",
      }),
      influenceSampler: config.influenceSampler,
      depthTexture: config.depthTexture.createView({
        dimension: "2d",
      }),
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
    // Build bind group with fallback textures if needed
    if (!this.bindGroup && this.initialized) {
      this.rebuildBindGroup();
    }

    if (!this.initialized || !this.shader || !this.buffers || !this.bindGroup) {
      return;
    }

    // Use provided config or fallback (fallback is always created in init)
    const config = this.influenceConfig ?? this.fallbackConfig!;

    const device = getWebGPU().device;

    // Get game time from TimeOfDay (unified time source)
    const game = (waterInfo as { game?: { elapsedUnpausedTime?: number } })
      .game;
    const timeOfDay = game
      ? TimeOfDay.maybeFromGame(
          game as Parameters<typeof TimeOfDay.maybeFromGame>[0],
        )
      : undefined;
    const time = timeOfDay
      ? timeOfDay.getTimeInSeconds()
      : (game?.elapsedUnpausedTime ?? 0);

    // Collect segment data from wake particles
    const segments = waterInfo.collectShaderSegmentData(viewport);
    const segmentCount = this.buffers.updateSegments(segments);

    const swellConfig = config.swellGridConfig;
    const fetchConfig = config.fetchGridConfig;
    const depthConfig = config.depthGridConfig;

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
      waveSourceDirection: config.waveSourceDirection,
      // Tide height
      tideHeight: waterInfo.getTideHeight(),
      // Depth grid config
      depthOriginX: depthConfig.originX,
      depthOriginY: depthConfig.originY,
      depthGridWidth: depthConfig.cellsX * depthConfig.cellSize,
      depthGridHeight: depthConfig.cellsY * depthConfig.cellSize,
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
    this.fallbackSwellTexture?.destroy();
    this.fallbackFetchTexture?.destroy();
    this.fallbackDepthTexture?.destroy();
    this.bindGroup = null;
    this.outputTextureView = null;
    this.buffers = null;
    this.shader = null;
    this.fallbackSwellTexture = null;
    this.fallbackFetchTexture = null;
    this.fallbackDepthTexture = null;
    this.fallbackSampler = null;
    this.fallbackConfig = null;
    this.initialized = false;
  }
}
