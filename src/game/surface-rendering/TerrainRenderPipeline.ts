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
} from "../../core/graphics/webgpu/GPUProfiler";
import { getWebGPU } from "../../core/graphics/webgpu/WebGPUDevice";
import { profile } from "../../core/util/Profiler";
import {
  TerrainContour,
  TerrainDefinition,
} from "../world-data/terrain/LandMass";
import { TerrainComputeBuffers } from "../world-data/terrain/webgpu/TerrainComputeBuffers";
import { TERRAIN_TEXTURE_SIZE } from "./SurfaceRenderer";
import { TerrainStateShader } from "../world-data/terrain/webgpu/TerrainStateShader";

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
  private shader: TerrainStateShader | null = null;
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
    this.shader = new TerrainStateShader();
    await this.shader.init();

    // Create shared buffers
    this.buffers = new TerrainComputeBuffers();

    // Create output texture (owned by this pipeline)
    // Use rgba32float like water - supports storage, filtering, and direct readback
    this.outputTexture = device.createTexture({
      size: { width: this.textureSize, height: this.textureSize },
      format: "rgba32float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      label: "Terrain Render Output Texture",
    });
    this.outputTextureView = this.outputTexture.createView();

    // Create bind group using type-safe shader method
    this.bindGroup = this.shader.createBindGroup({
      params: { buffer: this.buffers.paramsBuffer },
      controlPoints: { buffer: this.buffers.controlPointsBuffer },
      contours: { buffer: this.buffers.contourBuffer },
      outputTexture: this.outputTextureView,
    });

    this.initialized = true;
  }

  /**
   * Update terrain definition (contours).
   */
  setTerrainDefinition(definition: TerrainDefinition): void {
    this.buffers?.updateTerrainData(definition);
  }

  /**
   * Add a contour to the terrain.
   * Not supported - use setTerrainDefinition instead.
   */
  addContour(_contour: TerrainContour): void {
    throw new Error(
      "TerrainRenderPipeline.addContour is not supported. Use setTerrainDefinition instead.",
    );
  }

  /**
   * Update terrain texture with current state for the given viewport.
   * Runs every frame to keep terrain aligned with camera.
   */
  @profile
  update(
    viewport: TerrainViewport,
    time: number,
    gpuProfiler?: GPUProfiler | null,
    section: GPUProfileSection = "terrainCompute",
  ): void {
    if (!this.initialized || !this.shader || !this.buffers || !this.bindGroup) {
      return;
    }

    // Early exit if no terrain data - skip GPU compute entirely
    const contourCount = this.buffers.getContourCount();
    if (contourCount === 0) {
      return;
    }

    const device = getWebGPU().device;

    // Update params buffer with current viewport
    this.buffers.updateParams({
      time,
      viewportLeft: viewport.left,
      viewportTop: viewport.top,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      textureSize: this.textureSize,
      contourCount,
      defaultDepth: this.buffers.getDefaultDepth(),
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
   * Check if terrain data has been loaded.
   */
  hasTerrainData(): boolean {
    return (this.buffers?.getContourCount() ?? 0) > 0;
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
