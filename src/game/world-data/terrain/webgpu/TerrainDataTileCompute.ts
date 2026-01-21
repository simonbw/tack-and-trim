/**
 * Terrain physics tile compute implementation.
 *
 * Uses the TerrainStateShader for tile-based terrain queries.
 * Each instance owns its output texture; the shader and buffer management
 * are shared via TerrainStateShader and TerrainComputeBuffers.
 *
 * Implements DataTileCompute interface for use with DataTileComputePipeline.
 */

import { getWebGPU } from "../../../../core/graphics/webgpu/WebGPUDevice";
import type { DataTileCompute } from "../../datatiles/DataTileComputePipeline";
import { TERRAIN_TILE_RESOLUTION } from "../TerrainConstants";
import { TerrainComputeBuffers } from "./TerrainComputeBuffers";
import { TerrainStateShader } from "./TerrainStateShader";

/**
 * Terrain tile compute using shared shader infrastructure.
 * Implements DataTileCompute interface for use with DataTileComputePipeline.
 */
export class TerrainDataTileCompute implements DataTileCompute {
  private shader: TerrainStateShader;
  private buffers: TerrainComputeBuffers;
  private bindGroup: GPUBindGroup | null = null;
  private outputTexture: GPUTexture | null = null;

  private textureSize: number;

  constructor(
    buffers: TerrainComputeBuffers,
    textureSize: number = TERRAIN_TILE_RESOLUTION,
  ) {
    this.buffers = buffers;
    this.textureSize = textureSize;
    this.shader = new TerrainStateShader();
  }

  /**
   * Initialize WebGPU resources.
   */
  async init(): Promise<void> {
    const device = getWebGPU().device;

    // Initialize shared compute shader
    await this.shader.init();

    // Create output texture (owned by this tile compute instance)
    // rgba32float - matches TerrainStateShader output and water format
    this.outputTexture = device.createTexture({
      size: { width: this.textureSize, height: this.textureSize },
      format: "rgba32float",
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
      label: "Terrain Tile Output Texture",
    });

    // Create bind group using type-safe shader method
    this.bindGroup = this.shader.createBindGroup({
      params: { buffer: this.buffers.paramsBuffer },
      controlPoints: { buffer: this.buffers.controlPointsBuffer },
      landMasses: { buffer: this.buffers.landMassBuffer },
      outputTexture: this.outputTexture.createView(),
    });
  }

  /**
   * Run the compute shader for a tile viewport.
   */
  runCompute(
    time: number,
    left: number,
    top: number,
    width: number,
    height: number,
  ): void {
    if (!this.bindGroup) {
      return;
    }

    const device = getWebGPU().device;

    // Update params buffer
    this.buffers.updateParams({
      time,
      viewportLeft: left,
      viewportTop: top,
      viewportWidth: width,
      viewportHeight: height,
      textureSize: this.textureSize,
      landMassCount: this.buffers.getLandMassCount(),
    });

    // Create and submit compute pass
    const commandEncoder = device.createCommandEncoder({
      label: "Terrain Tile Compute Encoder",
    });

    const computePass = commandEncoder.beginComputePass({
      label: "Terrain Tile Compute Pass",
    });

    this.shader.dispatch(computePass, this.bindGroup, this.textureSize);

    computePass.end();

    device.queue.submit([commandEncoder.finish()]);
  }

  /**
   * Get the output texture for readback.
   */
  getOutputTexture(): GPUTexture | null {
    return this.outputTexture;
  }

  /**
   * Clean up GPU resources.
   */
  destroy(): void {
    this.outputTexture?.destroy();
    this.shader.destroy();
    this.bindGroup = null;
    // Don't destroy buffers - they're shared
  }
}
