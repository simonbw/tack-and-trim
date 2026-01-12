/**
 * WebGPU-based wind computation pipeline.
 *
 * Orchestrates:
 * 1. GPU: WindComputeGPU for base wind with noise variation
 * 2. GPU: WindModifierComputeGPU for sail and turbulence effects
 *
 * The outputs need to be combined (base wind + modifier delta) to get final wind velocity.
 */

import { GPUProfiler } from "../../../core/graphics/webgpu/GPUProfiler";
import { profile } from "../../../core/util/Profiler";
import { V2d } from "../../../core/Vector";
import { WIND_TEXTURE_SIZE } from "../WindConstants";
import type { GPUSailData, GPUTurbulenceData } from "./WindModifierData";
import { WindComputeGPU } from "./WindComputeGPU";
import { WindModifierComputeGPU } from "./WindModifierComputeGPU";

export interface WindViewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * WebGPU wind computation pipeline.
 */
export class WindComputePipelineGPU {
  private windCompute: WindComputeGPU | null = null;
  private modifierCompute: WindModifierComputeGPU | null = null;
  private initialized = false;

  /**
   * Initialize WebGPU resources.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    // Initialize base wind compute shader
    this.windCompute = new WindComputeGPU(WIND_TEXTURE_SIZE);
    await this.windCompute.init();

    // Initialize modifier compute shader
    this.modifierCompute = new WindModifierComputeGPU(WIND_TEXTURE_SIZE);
    await this.modifierCompute.init();

    this.initialized = true;
  }

  /**
   * Update wind textures for the given tile viewport.
   * @param viewport Tile bounds in world coordinates
   * @param time Current game time
   * @param baseWind Base wind velocity (before noise variation)
   * @param sails Sail modifier data for GPU
   * @param turbulence Turbulence particle data for GPU
   * @param gpuProfiler Optional GPU profiler for timing
   */
  @profile
  update(
    viewport: WindViewport,
    time: number,
    baseWind: V2d,
    sails: GPUSailData[],
    turbulence: GPUTurbulenceData[],
    gpuProfiler?: GPUProfiler | null,
  ): void {
    if (!this.initialized || !this.windCompute || !this.modifierCompute) return;

    const { left, top, width, height } = viewport;

    // Run base wind compute shader
    this.windCompute.compute(
      time,
      left,
      top,
      width,
      height,
      baseWind[0],
      baseWind[1],
      gpuProfiler,
      "windCompute",
    );

    // Run modifier compute shader
    this.modifierCompute.compute(
      left,
      top,
      width,
      height,
      sails,
      turbulence,
      gpuProfiler,
    );
  }

  /**
   * Get the base wind texture for readback.
   */
  getWindTexture(): GPUTexture | null {
    return this.windCompute?.getOutputTexture() ?? null;
  }

  /**
   * Get the base wind texture view for binding.
   */
  getWindTextureView(): GPUTextureView | null {
    return this.windCompute?.getOutputTextureView() ?? null;
  }

  /**
   * Get the modifier texture view for binding.
   */
  getModifierTextureView(): GPUTextureView | null {
    return this.modifierCompute?.getOutputTextureView() ?? null;
  }

  /**
   * Get the wind compute instance for readback.
   */
  getWindCompute(): WindComputeGPU | null {
    return this.windCompute;
  }

  /**
   * Get the modifier compute instance.
   */
  getModifierCompute(): WindModifierComputeGPU | null {
    return this.modifierCompute;
  }

  /**
   * Get texture size.
   */
  getTextureSize(): number {
    return WIND_TEXTURE_SIZE;
  }

  /**
   * Check if the pipeline is initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Destroy GPU resources.
   */
  destroy(): void {
    this.windCompute?.destroy();
    this.modifierCompute?.destroy();
    this.windCompute = null;
    this.modifierCompute = null;
    this.initialized = false;
  }
}
