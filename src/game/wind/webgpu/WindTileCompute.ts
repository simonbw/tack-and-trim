/**
 * Wind tile compute implementation.
 *
 * Uses the WindStateCompute shader for tile-based wind queries.
 * Each instance owns its output texture and params buffer;
 * the shader pipeline is shared via WindStateCompute.
 *
 * Implements DataTileCompute interface for use with DataTileComputePipeline.
 */

import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import type { DataTileCompute } from "../../datatiles/DataTileComputePipeline";
import { WindStateCompute } from "./WindStateCompute";

/**
 * Wind tile compute using shared shader infrastructure.
 * Implements DataTileCompute interface for use with DataTileComputePipeline.
 */
export class WindTileCompute implements DataTileCompute {
  private stateCompute: WindStateCompute;
  private paramsBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private outputTexture: GPUTexture | null = null;

  private textureSize: number;
  private baseWindX: number = 0;
  private baseWindY: number = 0;

  constructor(textureSize: number = 256) {
    this.textureSize = textureSize;
    this.stateCompute = new WindStateCompute();
  }

  /**
   * Initialize WebGPU resources.
   */
  async init(): Promise<void> {
    const device = getWebGPU().device;

    // Initialize shared compute shader
    await this.stateCompute.init();

    // Create params uniform buffer (48 bytes = 12 floats, aligned to 16)
    this.paramsBuffer = device.createBuffer({
      size: 48, // 12 floats * 4 bytes
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Wind Tile Params Buffer",
    });

    // Create output texture (owned by this tile compute instance)
    // rg32float - 2 channels for velocity X and Y
    this.outputTexture = device.createTexture({
      size: { width: this.textureSize, height: this.textureSize },
      format: "rg32float",
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
      label: "Wind Tile Output Texture",
    });

    // Create bind group using shared layout
    this.bindGroup = device.createBindGroup({
      layout: this.stateCompute.getBindGroupLayout(),
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuffer } },
        { binding: 1, resource: this.outputTexture.createView() },
      ],
      label: "Wind Tile Bind Group",
    });
  }

  /**
   * Set base wind velocity for next compute call.
   */
  setBaseWind(x: number, y: number): void {
    this.baseWindX = x;
    this.baseWindY = y;
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
    if (!this.paramsBuffer || !this.bindGroup) {
      return;
    }

    const device = getWebGPU().device;

    // Update params buffer
    const paramsData = new Float32Array([
      time,
      left, // viewportLeft
      top, // viewportTop
      width, // viewportWidth
      height, // viewportHeight
      this.textureSize, // textureSizeX
      this.textureSize, // textureSizeY
      0, // padding
      this.baseWindX,
      this.baseWindY,
      0, // padding2
      0, // padding3
    ]);
    device.queue.writeBuffer(this.paramsBuffer, 0, paramsData.buffer);

    // Create and submit compute pass
    const commandEncoder = device.createCommandEncoder({
      label: "Wind Tile Compute Encoder",
    });

    const computePass = commandEncoder.beginComputePass({
      label: "Wind Tile Compute Pass",
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
    this.paramsBuffer?.destroy();
    this.outputTexture?.destroy();
    this.stateCompute.destroy();
    this.bindGroup = null;
    this.paramsBuffer = null;
  }
}
