/**
 * WebGPU-based water computation pipeline.
 *
 * Orchestrates:
 * 1. GPU: WaveComputeGPU for Gerstner wave computation
 * 2. GPU: ModifierComputeGPU for wake modifiers
 *
 * Produces textures consumed by WaterShaderGPU for rendering.
 */

import { GPUProfiler } from "../../../core/graphics/webgpu/GPUProfiler";
import { profile } from "../../../core/util/Profiler";
import { WATER_TEXTURE_SIZE } from "../WaterConstants";
import type { WaterInfo } from "../WaterInfo";
import { ModifierComputeGPU } from "./ModifierComputeGPU";
import { ReadbackViewport, WaterReadbackBuffer } from "./WaterReadbackBuffer";
import { WaveComputeGPU } from "./WaveComputeGPU";

export interface Viewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * WebGPU water computation pipeline.
 */
export class WaterComputePipelineGPU {
  private waveCompute: WaveComputeGPU | null = null;
  private modifierCompute: ModifierComputeGPU | null = null;
  private initialized = false;

  // Readback buffer for physics queries
  private readbackBuffer: WaterReadbackBuffer;
  private lastComputeViewport: ReadbackViewport | null = null;

  constructor() {
    // Initialize readback buffer for physics queries
    this.readbackBuffer = new WaterReadbackBuffer(WATER_TEXTURE_SIZE);
  }

  /**
   * Initialize WebGPU resources.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    // Initialize wave compute shader
    this.waveCompute = new WaveComputeGPU(WATER_TEXTURE_SIZE);
    await this.waveCompute.init();

    // Initialize modifier compute shader
    this.modifierCompute = new ModifierComputeGPU(WATER_TEXTURE_SIZE);
    await this.modifierCompute.init();

    // Initialize readback buffer
    await this.readbackBuffer.init();

    this.initialized = true;
  }

  /**
   * Update water textures with current state for the given viewport.
   * @param gpuProfiler Optional GPU profiler for timing the compute pass
   */
  @profile
  update(
    viewport: Viewport,
    waterInfo: WaterInfo,
    gpuProfiler?: GPUProfiler | null,
  ): void {
    if (!this.initialized || !this.waveCompute || !this.modifierCompute) return;
    const { left, top, width, height } = viewport;

    // Get elapsed time from waterInfo's game reference
    const game = (waterInfo as { game?: { elapsedUnpausedTime?: number } })
      .game;
    const time = game?.elapsedUnpausedTime ?? 0;

    // Run wave compute shader
    this.waveCompute.compute(time, left, top, width, height, gpuProfiler);

    // Run modifier compute shader (GPU-based wake contribution)
    this.updateModifierTexture(viewport, waterInfo, gpuProfiler);
  }

  /**
   * Update modifier texture with wake contributions using GPU compute.
   * Made public so WaterRendererGPU can update it separately from compute.
   */
  @profile
  updateModifierTexture(
    viewport: Viewport,
    waterInfo: WaterInfo,
    gpuProfiler?: GPUProfiler | null,
  ): void {
    if (!this.modifierCompute) return;

    const { left, top, width, height } = viewport;

    // Collect segment data from wake particles (filtered by viewport)
    const segments = waterInfo.collectGPUSegmentData(viewport);

    // Run GPU compute shader
    this.modifierCompute.compute(
      left,
      top,
      width,
      height,
      segments,
      gpuProfiler,
    );
  }

  /**
   * Get the wave texture view for rendering.
   */
  getWaveTextureView(): GPUTextureView | null {
    return this.waveCompute?.getOutputTextureView() ?? null;
  }

  /**
   * Get the modifier texture view for rendering.
   */
  getModifierTextureView(): GPUTextureView | null {
    return this.modifierCompute?.getOutputTextureView() ?? null;
  }

  /**
   * Get the wave compute instance for readback.
   */
  getWaveCompute(): WaveComputeGPU | null {
    return this.waveCompute;
  }

  getTextureSize(): number {
    return WATER_TEXTURE_SIZE;
  }

  /**
   * Run GPU compute and initiate async readback.
   * Call at end of tick phase.
   *
   * @param viewport World-space bounds for computation
   * @param time Current game time (for physics consistency)
   * @param gpuProfiler Optional GPU profiler for timing
   */
  @profile
  computeAndInitiateReadback(
    viewport: Viewport,
    time: number,
    gpuProfiler?: GPUProfiler | null,
  ): void {
    if (!this.initialized || !this.waveCompute) return;

    const { left, top, width, height } = viewport;

    // Run GPU compute
    this.waveCompute.compute(time, left, top, width, height, gpuProfiler);

    // Store viewport with time for readback
    this.lastComputeViewport = { ...viewport, time };

    // Initiate async readback
    const outputTexture = this.waveCompute.getOutputTexture();
    if (outputTexture) {
      this.readbackBuffer.initiateReadback(
        outputTexture,
        this.lastComputeViewport,
        gpuProfiler,
      );
    }
  }

  /**
   * Complete readback from previous frame.
   * Call at start of tick phase.
   *
   * @returns True if readback completed successfully
   */
  async completeReadback(): Promise<boolean> {
    return this.readbackBuffer.completeReadback();
  }

  /**
   * Get the readback buffer for sampling wave data.
   */
  getReadbackBuffer(): WaterReadbackBuffer {
    return this.readbackBuffer;
  }

  /**
   * Check if the pipeline is initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  destroy(): void {
    this.waveCompute?.destroy();
    this.modifierCompute?.destroy();
    this.readbackBuffer.destroy();
    this.waveCompute = null;
    this.modifierCompute = null;
    this.lastComputeViewport = null;
    this.initialized = false;
  }
}
