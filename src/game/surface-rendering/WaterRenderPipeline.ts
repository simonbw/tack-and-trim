/**
 * Water rendering compute pipeline.
 *
 * Uses the WaterStateShader for rendering.
 * Owns a single output texture (rgba32float) containing combined
 * wave + modifier data.
 *
 * This replaces the old WaterComputePipelineGPU which used
 * separate WaveComputeGPU and ModifierComputeGPU shaders.
 */

import {
  GPUProfiler,
  GPUProfileSection,
} from "../../core/graphics/webgpu/GPUProfiler";
import { getWebGPU } from "../../core/graphics/webgpu/WebGPUDevice";
import { profile } from "../../core/util/Profiler";
import type { Viewport, WaterInfo } from "../world-data/water/WaterInfo";
import { WATER_TEXTURE_SIZE } from "./SurfaceRenderer";
import { WaterComputeBuffers } from "../world-data/water/webgpu/WaterComputeBuffers";
import { WaterStateShader } from "../world-data/water/webgpu/WaterStateShader";

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

    // Create bind group using type-safe shader method
    this.bindGroup = this.shader.createBindGroup({
      params: { buffer: this.buffers.paramsBuffer },
      waveData: { buffer: this.buffers.waveDataBuffer },
      segments: { buffer: this.buffers.segmentsBuffer },
      outputTexture: this.outputTextureView,
    });

    this.initialized = true;
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
    if (!this.initialized || !this.shader || !this.buffers || !this.bindGroup) {
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

    // Update params buffer
    this.buffers.updateParams({
      time,
      viewportLeft: viewport.left,
      viewportTop: viewport.top,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      textureSize: this.textureSize,
      segmentCount,
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
