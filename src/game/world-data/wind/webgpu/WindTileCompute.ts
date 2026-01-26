/**
 * Wind tile compute implementation.
 *
 * Uses the WindStateShader for tile-based wind queries.
 * Each instance owns its output texture and params buffer;
 * the shader pipeline is shared via WindStateShader.
 *
 * Implements DataTileCompute interface for use with DataTileComputePipeline.
 */

import { getWebGPU } from "../../../../core/graphics/webgpu/WebGPUDevice";
import { type UniformInstance } from "../../../../core/graphics/UniformStruct";
import type { DataTileCompute } from "../../datatiles/DataTileComputePipeline";
import { WindStateShader } from "./WindStateShader";
import { WindParams } from "./WindParams";

/**
 * Wind tile compute using shared shader infrastructure.
 * Implements DataTileCompute interface for use with DataTileComputePipeline.
 */
export class WindTileCompute implements DataTileCompute {
  private shader: WindStateShader;
  private paramsBuffer: GPUBuffer | null = null;
  private params: UniformInstance<typeof WindParams.fields> | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private outputTexture: GPUTexture | null = null;

  private textureSize: number;
  private baseWindX: number = 0;
  private baseWindY: number = 0;

  // Terrain influence parameters
  private influenceSpeedFactor: number = 1.0;
  private influenceDirectionOffset: number = 0;
  private influenceTurbulence: number = 0;

  constructor(textureSize: number = 256) {
    this.textureSize = textureSize;
    this.shader = new WindStateShader();
  }

  /**
   * Initialize WebGPU resources.
   */
  async init(): Promise<void> {
    const device = getWebGPU().device;

    // Initialize shared compute shader
    await this.shader.init();

    // Create params uniform buffer and instance
    this.paramsBuffer = device.createBuffer({
      size: WindParams.byteSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Wind Tile Params Buffer",
    });
    this.params = WindParams.create();

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

    // Create bind group using type-safe shader method
    this.bindGroup = this.shader.createBindGroup({
      params: { buffer: this.paramsBuffer },
      outputTexture: this.outputTexture.createView(),
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
   * Set terrain influence parameters for next compute call.
   * @param speedFactor - Multiplier for wind speed (1.0 = no change)
   * @param directionOffset - Radians to rotate wind direction
   * @param turbulence - Extra noise multiplier (0 = no extra turbulence)
   */
  setInfluence(
    speedFactor: number,
    directionOffset: number,
    turbulence: number,
  ): void {
    this.influenceSpeedFactor = speedFactor;
    this.influenceDirectionOffset = directionOffset;
    this.influenceTurbulence = turbulence;
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
    if (!this.paramsBuffer || !this.bindGroup || !this.params) {
      return;
    }

    // Update params using type-safe setters
    this.params.set.time(time);
    this.params.set.viewportLeft(left);
    this.params.set.viewportTop(top);
    this.params.set.viewportWidth(width);
    this.params.set.viewportHeight(height);
    this.params.set.textureSizeX(this.textureSize);
    this.params.set.textureSizeY(this.textureSize);
    this.params.set._padding(0);
    this.params.set.baseWind([this.baseWindX, this.baseWindY] as const);
    this.params.set._padding2([0, 0] as const);
    this.params.set.influenceSpeedFactor(this.influenceSpeedFactor);
    this.params.set.influenceDirectionOffset(this.influenceDirectionOffset);
    this.params.set.influenceTurbulence(this.influenceTurbulence);
    this.params.set._padding4(0);

    // Upload to GPU
    this.params.uploadTo(this.paramsBuffer);

    // Create and submit compute pass
    const device = getWebGPU().device;
    const commandEncoder = device.createCommandEncoder({
      label: "Wind Tile Compute Encoder",
    });

    const computePass = commandEncoder.beginComputePass({
      label: "Wind Tile Compute Pass",
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
    this.paramsBuffer?.destroy();
    this.outputTexture?.destroy();
    this.shader.destroy();
    this.bindGroup = null;
    this.paramsBuffer = null;
  }
}
