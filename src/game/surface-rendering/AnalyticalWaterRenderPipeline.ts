/**
 * Analytical Water Rendering Pipeline
 *
 * Uses the AnalyticalWaterStateShader with texture-based shadow system
 * for wave diffraction instead of grid-based influence textures.
 *
 * Key features:
 * - Shadow texture sampling instead of per-pixel polygon iteration
 * - Shadow data uniform buffer with silhouette positions
 * - Still uses 2D depth texture for shoaling/damping
 */

import {
  GPUProfiler,
  GPUProfileSection,
} from "../../core/graphics/webgpu/GPUProfiler";
import { getWebGPU } from "../../core/graphics/webgpu/WebGPUDevice";
import { profile } from "../../core/util/Profiler";
import { TimeOfDay } from "../time/TimeOfDay";
import type { DepthGridConfig } from "../world-data/influence/InfluenceFieldTypes";
import type { Viewport, WaterInfo } from "../world-data/water/WaterInfo";
import { WaterComputeBuffers } from "../world-data/water/webgpu/WaterComputeBuffers";
import { AnalyticalWaterStateShader } from "../world-data/water/webgpu/AnalyticalWaterStateShader";
import { WAVE_COMPONENTS } from "../world-data/water/WaterConstants";

// Default depth grid config for fallback
const FALLBACK_DEPTH_CONFIG: DepthGridConfig = {
  originX: -10000,
  originY: -10000,
  cellSize: 100,
  cellsX: 1,
  cellsY: 1,
};

/**
 * Analytical water configuration (depth texture + shadow texture/sampler).
 */
export interface AnalyticalRenderConfig {
  depthTexture: GPUTexture;
  depthSampler: GPUSampler;
  depthGridConfig: DepthGridConfig;
  shadowTextureView: GPUTextureView;
  shadowSampler: GPUSampler;
  waveSourceDirection: number;
}

/**
 * Analytical water rendering pipeline using shadow texture sampling.
 */
export class AnalyticalWaterRenderPipeline {
  private shader: AnalyticalWaterStateShader | null = null;
  private buffers: WaterComputeBuffers | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private outputTexture: GPUTexture | null = null;
  private outputTextureView: GPUTextureView | null = null;
  private initialized = false;

  private textureWidth: number;
  private textureHeight: number;

  // Analytical config (depth + shadow texture)
  private analyticalConfig: AnalyticalRenderConfig | null = null;

  // Fallback resources for when no config provided
  private fallbackDepthTexture: GPUTexture | null = null;
  private fallbackDepthSampler: GPUSampler | null = null;
  private fallbackShadowTexture: GPUTexture | null = null;
  private fallbackShadowSampler: GPUSampler | null = null;

  constructor(textureWidth: number, textureHeight: number) {
    this.textureWidth = textureWidth;
    this.textureHeight = textureHeight;
  }

  /**
   * Initialize WebGPU resources.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    const device = getWebGPU().device;

    // Initialize analytical compute shader
    this.shader = new AnalyticalWaterStateShader();
    await this.shader.init();

    // Create shared buffers
    this.buffers = new WaterComputeBuffers();

    // Create output texture
    this.outputTexture = device.createTexture({
      size: { width: this.textureWidth, height: this.textureHeight },
      format: "rgba32float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      label: "Analytical Water Render Output Texture",
    });
    this.outputTextureView = this.outputTexture.createView();

    // Create fallback depth texture (deep water, no shoaling)
    this.fallbackDepthTexture = device.createTexture({
      size: { width: 1, height: 1 },
      format: "r32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      label: "Fallback Depth Texture",
    });

    device.queue.writeTexture(
      { texture: this.fallbackDepthTexture },
      new Float32Array([-100.0]), // Deep water
      { bytesPerRow: 4 },
      { width: 1, height: 1 },
    );

    this.fallbackDepthSampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    // Create fallback shadow texture (no shadows)
    this.fallbackShadowTexture = device.createTexture({
      size: { width: 1, height: 1 },
      format: "r8uint",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      label: "Fallback Shadow Texture",
    });

    device.queue.writeTexture(
      { texture: this.fallbackShadowTexture },
      new Uint8Array([0]), // No shadow
      { bytesPerRow: 1 },
      { width: 1, height: 1 },
    );

    // Create fallback shadow sampler
    this.fallbackShadowSampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
      label: "Fallback Shadow Sampler",
    });

    this.initialized = true;
  }

  /**
   * Set analytical configuration (depth texture + shadow texture/buffer).
   */
  setAnalyticalConfig(config: AnalyticalRenderConfig): void {
    this.analyticalConfig = config;
    this.rebuildBindGroup();
  }

  /**
   * Rebuild the bind group with current resources.
   */
  private rebuildBindGroup(): void {
    if (
      !this.shader ||
      !this.buffers ||
      !this.outputTextureView ||
      !this.analyticalConfig
    ) {
      return;
    }

    const config = this.analyticalConfig;

    // Create bind group with shadow texture and data buffer
    this.bindGroup = this.shader.createBindGroup({
      params: { buffer: this.buffers.paramsBuffer },
      waveData: { buffer: this.buffers.waveDataBuffer },
      segments: { buffer: this.buffers.segmentsBuffer },
      outputTexture: this.outputTextureView,
      depthTexture: config.depthTexture.createView({ dimension: "2d" }),
      depthSampler: config.depthSampler,
      shadowTexture: config.shadowTextureView,
      shadowSampler: config.shadowSampler,
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
    // Can't render without analytical config
    if (!this.analyticalConfig) {
      return;
    }

    // Build bind group if needed
    if (!this.bindGroup && this.initialized) {
      this.rebuildBindGroup();
    }

    if (!this.initialized || !this.shader || !this.buffers || !this.bindGroup) {
      return;
    }

    const config = this.analyticalConfig;
    const device = getWebGPU().device;

    // Get game time from TimeOfDay
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

    const depthConfig = config.depthGridConfig;

    // Update params buffer (analytical format)
    const paramsData = new Float32Array(16);
    paramsData[0] = time;
    paramsData[1] = viewport.left;
    paramsData[2] = viewport.top;
    paramsData[3] = viewport.width;
    paramsData[4] = viewport.height;
    paramsData[5] = this.textureWidth;
    paramsData[6] = this.textureHeight;
    new DataView(paramsData.buffer).setUint32(7 * 4, segmentCount, true);
    paramsData[8] = depthConfig.originX;
    paramsData[9] = depthConfig.originY;
    paramsData[10] = depthConfig.cellsX * depthConfig.cellSize;
    paramsData[11] = depthConfig.cellsY * depthConfig.cellSize;
    paramsData[12] = config.waveSourceDirection;
    paramsData[13] = waterInfo.getTideHeight();
    paramsData[14] = 0; // padding
    paramsData[15] = 0; // padding

    device.queue.writeBuffer(this.buffers.paramsBuffer, 0, paramsData);

    // Create command encoder
    const commandEncoder = device.createCommandEncoder({
      label: "Analytical Water Render Compute Encoder",
    });

    // Begin compute pass with optional timestamp writes
    const computePass = commandEncoder.beginComputePass({
      label: "Analytical Water Render Compute Pass",
      timestampWrites: gpuProfiler?.getComputeTimestampWrites(section),
    });

    this.shader.dispatch(
      computePass,
      this.bindGroup,
      this.textureWidth,
      this.textureHeight,
    );

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
   * Get the texture width.
   */
  getTextureWidth(): number {
    return this.textureWidth;
  }

  /**
   * Get the texture height.
   */
  getTextureHeight(): number {
    return this.textureHeight;
  }

  /**
   * Check if the pipeline is initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Check if analytical config is set.
   */
  hasAnalyticalConfig(): boolean {
    return this.analyticalConfig !== null;
  }

  /**
   * Clean up GPU resources.
   */
  destroy(): void {
    this.buffers?.destroy();
    this.outputTexture?.destroy();
    this.shader?.destroy();
    this.fallbackDepthTexture?.destroy();
    this.fallbackShadowTexture?.destroy();
    this.bindGroup = null;
    this.outputTextureView = null;
    this.buffers = null;
    this.shader = null;
    this.fallbackDepthTexture = null;
    this.fallbackDepthSampler = null;
    this.fallbackShadowTexture = null;
    this.fallbackShadowSampler = null;
    this.analyticalConfig = null;
    this.initialized = false;
  }
}
