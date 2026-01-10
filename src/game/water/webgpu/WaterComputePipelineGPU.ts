/**
 * WebGPU-based water computation pipeline.
 *
 * Orchestrates:
 * 1. GPU: WaveComputeGPU for Gerstner wave computation
 * 2. CPU: ModifierDataTexture for wakes (still CPU-based for now)
 *
 * Produces textures consumed by WaterShaderGPU for rendering.
 */

import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import { profiler } from "../../../core/util/Profiler";
import { V } from "../../../core/Vector";
import { WATER_TEXTURE_SIZE } from "../WaterConstants";
import type { WaterInfo } from "../WaterInfo";
import { WaterReadbackBuffer, ReadbackViewport } from "./WaterReadbackBuffer";
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
  private modifierTexture: GPUTexture | null = null;
  private modifierTextureView: GPUTextureView | null = null;
  private modifierData: Uint8Array;
  private initialized = false;

  // Readback buffer for physics queries
  private readbackBuffer: WaterReadbackBuffer;
  private lastComputeViewport: ReadbackViewport | null = null;

  constructor() {
    // Pre-allocate modifier texture data (RGBA8)
    this.modifierData = new Uint8Array(WATER_TEXTURE_SIZE * WATER_TEXTURE_SIZE * 4);
    // Initialize with neutral values (0.5 = no modification)
    for (let i = 0; i < this.modifierData.length; i += 4) {
      this.modifierData[i] = 128; // R: height modifier (0.5 = neutral)
      this.modifierData[i + 1] = 128; // G: unused
      this.modifierData[i + 2] = 128; // B: unused
      this.modifierData[i + 3] = 255; // A: opacity
    }

    // Initialize readback buffer for physics queries
    this.readbackBuffer = new WaterReadbackBuffer(WATER_TEXTURE_SIZE);
  }

  /**
   * Initialize WebGPU resources.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    const device = getWebGPU().device;

    // Initialize wave compute shader
    this.waveCompute = new WaveComputeGPU(WATER_TEXTURE_SIZE);
    await this.waveCompute.init();

    // Initialize readback buffer
    await this.readbackBuffer.init();

    // Create modifier texture (CPU-uploaded)
    this.modifierTexture = device.createTexture({
      size: { width: WATER_TEXTURE_SIZE, height: WATER_TEXTURE_SIZE },
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST,
      label: "Modifier Texture",
    });
    this.modifierTextureView = this.modifierTexture.createView();

    // Upload initial neutral data
    device.queue.writeTexture(
      { texture: this.modifierTexture },
      this.modifierData.buffer,
      { bytesPerRow: WATER_TEXTURE_SIZE * 4, rowsPerImage: WATER_TEXTURE_SIZE },
      { width: WATER_TEXTURE_SIZE, height: WATER_TEXTURE_SIZE }
    );

    this.initialized = true;
  }

  /**
   * Update water textures with current state for the given viewport.
   */
  update(viewport: Viewport, waterInfo: WaterInfo): void {
    if (!this.initialized || !this.waveCompute) return;

    const { left, top, width, height } = viewport;

    profiler.start("water-compute-pipeline-gpu");

    // Get elapsed time from waterInfo's game reference
    const game = (waterInfo as { game?: { elapsedUnpausedTime?: number } }).game;
    const time = game?.elapsedUnpausedTime ?? 0;

    // Run GPU wave computation
    profiler.start("wave-gpu-compute");
    this.waveCompute.compute(time, left, top, width, height);
    profiler.end("wave-gpu-compute");

    // Update modifier texture from CPU water modifiers
    profiler.start("modifier-update");
    this.updateModifierTexture(viewport, waterInfo);
    profiler.end("modifier-update");

    profiler.end("water-compute-pipeline-gpu");
  }

  /**
   * Update modifier texture with wake contributions.
   * Made public so WaterRendererGPU can update it separately from compute.
   */
  updateModifierTexture(viewport: Viewport, waterInfo: WaterInfo): void {
    if (!this.modifierTexture) return;

    const device = getWebGPU().device;
    const { left, top, width, height } = viewport;
    const texSize = WATER_TEXTURE_SIZE;

    // Reset to neutral
    for (let i = 0; i < this.modifierData.length; i += 4) {
      this.modifierData[i] = 128;
      this.modifierData[i + 1] = 128;
      this.modifierData[i + 2] = 128;
      this.modifierData[i + 3] = 255;
    }

    // Sample modifiers and write to texture
    const modifiers = waterInfo.getAllModifiers();
    for (const modifier of modifiers) {
      const aabb = modifier.getWaterModifierAABB();

      // Convert world AABB to texture coordinates
      const minU = Math.max(0, Math.floor(((aabb.minX - left) / width) * texSize));
      const maxU = Math.min(texSize, Math.ceil(((aabb.maxX - left) / width) * texSize));
      const minV = Math.max(0, Math.floor(((aabb.minY - top) / height) * texSize));
      const maxV = Math.min(texSize, Math.ceil(((aabb.maxY - top) / height) * texSize));

      // Sample contribution at each pixel
      for (let v = minV; v < maxV; v++) {
        for (let u = minU; u < maxU; u++) {
          const worldX = left + (u / texSize) * width;
          const worldY = top + (v / texSize) * height;

          const contrib = modifier.getWaterContribution(V(worldX, worldY));
          if (Math.abs(contrib.height) > 0.001) {
            const idx = (v * texSize + u) * 4;
            // Add height contribution (normalized to 0-255 range)
            const currentHeight = this.modifierData[idx] / 255;
            const newHeight = Math.max(0, Math.min(1, currentHeight + contrib.height * 0.1));
            this.modifierData[idx] = Math.floor(newHeight * 255);
          }
        }
      }
    }

    // Upload to GPU
    device.queue.writeTexture(
      { texture: this.modifierTexture },
      this.modifierData.buffer,
      { bytesPerRow: texSize * 4, rowsPerImage: texSize },
      { width: texSize, height: texSize }
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
    return this.modifierTextureView;
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
   */
  computeAndInitiateReadback(viewport: Viewport, time: number): void {
    if (!this.initialized || !this.waveCompute) return;

    const { left, top, width, height } = viewport;

    profiler.start("water-compute-readback");

    // Run GPU compute
    this.waveCompute.compute(time, left, top, width, height);

    // Store viewport with time for readback
    this.lastComputeViewport = { ...viewport, time };

    // Initiate async readback
    const outputTexture = this.waveCompute.getOutputTexture();
    if (outputTexture) {
      this.readbackBuffer.initiateReadback(outputTexture, this.lastComputeViewport);
    }

    profiler.end("water-compute-readback");
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
    this.modifierTexture?.destroy();
    this.readbackBuffer.destroy();
    this.waveCompute = null;
    this.modifierTexture = null;
    this.modifierTextureView = null;
    this.lastComputeViewport = null;
    this.initialized = false;
  }
}
