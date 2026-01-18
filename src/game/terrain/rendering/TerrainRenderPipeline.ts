/**
 * Terrain rendering compute pipeline.
 *
 * Computes terrain height texture for the visible viewport.
 * Similar to WaterRenderPipeline but for terrain.
 * Output is passed to WaterShader for depth-based rendering.
 */

import {
  GPUProfiler,
  GPUProfileSection,
} from "../../../core/graphics/webgpu/GPUProfiler";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import { profile } from "../../../core/util/Profiler";
import { LandMass, TerrainDefinition } from "../LandMass";
import { TERRAIN_TEXTURE_SIZE } from "../TerrainConstants";
import { TerrainComputeBuffers } from "../webgpu/TerrainComputeBuffers";
import { TerrainStateCompute } from "../webgpu/TerrainStateCompute";

/**
 * Viewport bounds for terrain computation.
 */
export interface TerrainViewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Terrain rendering compute pipeline.
 */
export class TerrainRenderPipeline {
  private stateCompute: TerrainStateCompute | null = null;
  private buffers: TerrainComputeBuffers | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private outputTexture: GPUTexture | null = null;
  private outputTextureView: GPUTextureView | null = null;
  private initialized = false;

  private textureSize: number;

  // Track terrain definition version to avoid redundant buffer updates
  private terrainVersion: number = 0;

  // Track last computed viewport to avoid redundant compute
  private lastViewport: TerrainViewport | null = null;
  private needsCompute = true;

  constructor(textureSize: number = TERRAIN_TEXTURE_SIZE) {
    this.textureSize = textureSize;
  }

  /**
   * Initialize WebGPU resources.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    const device = getWebGPU().device;

    // Initialize shared compute shader
    this.stateCompute = new TerrainStateCompute();
    await this.stateCompute.init();

    // Create shared buffers
    this.buffers = new TerrainComputeBuffers();

    // Create output texture (owned by this pipeline)
    // r32float - single channel for height
    this.outputTexture = device.createTexture({
      size: { width: this.textureSize, height: this.textureSize },
      format: "r32float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      label: "Terrain Render Output Texture",
    });
    this.outputTextureView = this.outputTexture.createView();

    // Create bind group using shared layout
    this.bindGroup = device.createBindGroup({
      layout: this.stateCompute.getBindGroupLayout(),
      entries: [
        { binding: 0, resource: { buffer: this.buffers.paramsBuffer } },
        { binding: 1, resource: { buffer: this.buffers.controlPointsBuffer } },
        { binding: 2, resource: { buffer: this.buffers.landMassBuffer } },
        { binding: 3, resource: this.outputTextureView },
      ],
      label: "Terrain Render Bind Group",
    });

    this.initialized = true;
  }

  /**
   * Update terrain definition (land masses).
   */
  setTerrainDefinition(definition: TerrainDefinition): void {
    this.buffers?.updateTerrainData(definition);
    this.needsCompute = true; // Terrain changed, need to recompute
  }

  /**
   * Add a land mass to the terrain.
   */
  addLandMass(landMass: LandMass): void {
    // This requires keeping track of land masses, so delegate to external
    // TerrainInfo for now. Direct add is not supported without tracking state.
    console.warn(
      "TerrainRenderPipeline.addLandMass: Use setTerrainDefinition instead"
    );
  }

  /**
   * Check if viewport has changed enough to require recompute.
   * Uses a threshold to avoid recomputing on tiny camera movements.
   */
  private viewportChanged(viewport: TerrainViewport): boolean {
    if (!this.lastViewport) return true;

    // Threshold: recompute if viewport moved by more than 10% of its size
    const threshold = 0.1;
    const dx = Math.abs(viewport.left - this.lastViewport.left);
    const dy = Math.abs(viewport.top - this.lastViewport.top);
    const dw = Math.abs(viewport.width - this.lastViewport.width);
    const dh = Math.abs(viewport.height - this.lastViewport.height);

    return (
      dx > viewport.width * threshold ||
      dy > viewport.height * threshold ||
      dw > viewport.width * threshold ||
      dh > viewport.height * threshold
    );
  }

  /**
   * Update terrain texture with current state for the given viewport.
   */
  @profile
  update(
    viewport: TerrainViewport,
    time: number,
    gpuProfiler?: GPUProfiler | null,
    section: GPUProfileSection = "terrainCompute"
  ): void {
    if (
      !this.initialized ||
      !this.stateCompute ||
      !this.buffers ||
      !this.bindGroup
    ) {
      return;
    }

    // Early exit if no terrain data - skip GPU compute entirely
    const landMassCount = this.buffers.getLandMassCount();
    if (landMassCount === 0) {
      return;
    }

    // Skip compute if viewport hasn't changed significantly
    if (!this.needsCompute && !this.viewportChanged(viewport)) {
      return;
    }

    const device = getWebGPU().device;

    // Update params buffer
    this.buffers.updateParams({
      time,
      viewportLeft: viewport.left,
      viewportTop: viewport.top,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      textureSize: this.textureSize,
      landMassCount,
    });

    // Create command encoder
    const commandEncoder = device.createCommandEncoder({
      label: "Terrain Render Compute Encoder",
    });

    // Begin compute pass with optional timestamp writes
    const computePass = commandEncoder.beginComputePass({
      label: "Terrain Render Compute Pass",
      timestampWrites: gpuProfiler?.getComputeTimestampWrites(section),
    });

    this.stateCompute.dispatch(computePass, this.bindGroup, this.textureSize);

    computePass.end();

    // Submit
    device.queue.submit([commandEncoder.finish()]);

    // Track that we've computed for this viewport
    this.lastViewport = { ...viewport };
    this.needsCompute = false;
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
   * Check if terrain data has been loaded.
   */
  hasTerrainData(): boolean {
    return (this.buffers?.getLandMassCount() ?? 0) > 0;
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
