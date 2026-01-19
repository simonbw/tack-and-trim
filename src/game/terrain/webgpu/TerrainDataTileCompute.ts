/**
 * Terrain physics tile compute implementation.
 *
 * Uses the unified TerrainStateCompute shader for tile-based terrain queries.
 * Each instance owns its output texture; the shader and buffer management
 * are shared via TerrainStateCompute and TerrainComputeBuffers.
 *
 * Implements DataTileCompute interface for use with DataTileComputePipeline.
 */

import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import type { DataTileCompute } from "../../datatiles/DataTileComputePipeline";
import { TERRAIN_TILE_RESOLUTION } from "../TerrainConstants";
import { TerrainComputeBuffers } from "./TerrainComputeBuffers";
import { TerrainStateCompute } from "./TerrainStateCompute";

/**
 * Terrain tile compute using shared shader infrastructure.
 * Implements DataTileCompute interface for use with DataTileComputePipeline.
 */
export class TerrainDataTileCompute implements DataTileCompute {
  private stateCompute: TerrainStateCompute;
  private buffers: TerrainComputeBuffers;
  private bindGroup: GPUBindGroup | null = null;
  private outputTexture: GPUTexture | null = null;

  private textureSize: number;

  constructor(
    buffers: TerrainComputeBuffers,
    textureSize: number = TERRAIN_TILE_RESOLUTION
  ) {
    this.buffers = buffers;
    this.textureSize = textureSize;
    this.stateCompute = new TerrainStateCompute();
  }

  /**
   * Initialize WebGPU resources.
   */
  async init(): Promise<void> {
    const device = getWebGPU().device;

    // Initialize shared compute shader
    await this.stateCompute.init();

    // Create output texture (owned by this tile compute instance)
    // rgba32float - matches TerrainStateCompute shader and water format
    this.outputTexture = device.createTexture({
      size: { width: this.textureSize, height: this.textureSize },
      format: "rgba32float",
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
      label: "Terrain Tile Output Texture",
    });

    // Create bind group using shared layout
    this.bindGroup = device.createBindGroup({
      layout: this.stateCompute.getBindGroupLayout(),
      entries: [
        { binding: 0, resource: { buffer: this.buffers.paramsBuffer } },
        { binding: 1, resource: { buffer: this.buffers.controlPointsBuffer } },
        { binding: 2, resource: { buffer: this.buffers.landMassBuffer } },
        { binding: 3, resource: this.outputTexture.createView() },
      ],
      label: "Terrain Tile Bind Group",
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
    height: number
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

    this.stateCompute.dispatch(computePass, this.bindGroup, this.textureSize);

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
    this.stateCompute.destroy();
    this.bindGroup = null;
    // Don't destroy buffers - they're shared
  }
}
