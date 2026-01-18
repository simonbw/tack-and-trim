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

    const device = getWebGPU().device;

    // Update params buffer
    this.buffers.updateParams({
      time,
      viewportLeft: viewport.left,
      viewportTop: viewport.top,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      textureSize: this.textureSize,
      landMassCount: this.buffers.getLandMassCount(),
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
