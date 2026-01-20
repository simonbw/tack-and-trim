/**
 * Water rendering compute pipeline.
 *
 * Uses the unified WaterStateCompute shader for rendering.
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
import { WATER_TEXTURE_SIZE } from "../water/WaterConstants";
import type { Viewport, WaterInfo } from "../water/WaterInfo";
import { WaterComputeBuffers } from "../water/webgpu/WaterComputeBuffers";
import { WaterStateCompute } from "../water/webgpu/WaterStateCompute";

/**
 * Water rendering compute pipeline using unified shader.
 */
export class WaterRenderPipeline {
  private stateCompute: WaterStateCompute | null = null;
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
    this.stateCompute = new WaterStateCompute();
    await this.stateCompute.init();

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

    // Create bind group using shared layout
    this.bindGroup = device.createBindGroup({
      layout: this.stateCompute.getBindGroupLayout(),
      entries: [
        { binding: 0, resource: { buffer: this.buffers.paramsBuffer } },
        { binding: 1, resource: { buffer: this.buffers.waveDataBuffer } },
        { binding: 2, resource: { buffer: this.buffers.segmentsBuffer } },
        { binding: 3, resource: this.outputTextureView },
      ],
      label: "Water Render Bind Group",
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
    if (
      !this.initialized ||
      !this.stateCompute ||
      !this.buffers ||
      !this.bindGroup
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

    this.stateCompute.dispatch(computePass, this.bindGroup, this.textureSize);

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
    this.stateCompute?.destroy();
    this.bindGroup = null;
    this.outputTextureView = null;
    this.buffers = null;
    this.stateCompute = null;
    this.initialized = false;
  }
}
