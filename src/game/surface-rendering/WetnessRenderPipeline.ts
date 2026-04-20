/**
 * Wetness rendering compute pipeline.
 *
 * Tracks sand wetness over time using ping-pong textures.
 * When waves wash over sand, it becomes wet. When water recedes,
 * sand slowly dries out.
 *
 * Uses reprojection to maintain wetness state as the camera moves.
 */

import { Matrix3 } from "../../core/graphics/Matrix3";
import type { GPUProfiler } from "../../core/graphics/webgpu/GPUProfiler";
import { profile } from "../../core/util/Profiler";
import type { ComputeShader } from "../../core/graphics/webgpu/ComputeShader";
import {
  createWetnessStateShader,
  DEFAULT_DRYING_RATE,
  DEFAULT_WETTING_RATE,
  WetnessUniforms,
} from "./WetnessStateShader";

/**
 * Wetness rendering compute pipeline using ping-pong textures.
 */
export class WetnessRenderPipeline {
  private shader: ComputeShader | null = null;

  // Ping-pong textures for persistent state
  private wetnessTextureA: GPUTexture | null = null;
  private wetnessTextureB: GPUTexture | null = null;
  private wetnessTextureViewA: GPUTextureView | null = null;
  private wetnessTextureViewB: GPUTextureView | null = null;

  // Track which texture is currently being read
  private currentReadTexture: "A" | "B" = "A";

  // Two bind groups for ping-pong (read A -> write B, read B -> write A)
  private bindGroupAtoB: GPUBindGroup | null = null;
  private bindGroupBtoA: GPUBindGroup | null = null;

  // Previous frame's world→clip transform for reprojection
  private prevWorldToTexClip: Matrix3 | null = null;

  // Uniform buffer for shader params
  private paramsBuffer: GPUBuffer | null = null;
  private uniforms = WetnessUniforms.create();

  // Sampler for texture sampling
  private sampler: GPUSampler | null = null;

  private textureWidth: number;
  private textureHeight: number;
  private initialized = false;

  // Configurable rates
  private wettingRate = DEFAULT_WETTING_RATE;
  private dryingRate = DEFAULT_DRYING_RATE;

  constructor(
    private device: GPUDevice,
    textureWidth: number,
    textureHeight: number,
  ) {
    this.textureWidth = textureWidth;
    this.textureHeight = textureHeight;
  }

  /**
   * Initialize WebGPU resources.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    const device = this.device;

    // Initialize compute shader
    this.shader = createWetnessStateShader();
    await this.shader.init();

    // Create params buffer
    this.paramsBuffer = device.createBuffer({
      size: WetnessUniforms.byteSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Wetness Params Buffer",
    });

    // Create sampler (linear for smooth reprojection)
    this.sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
      label: "Wetness Sampler",
    });

    // Create ping-pong textures (r32float for single channel wetness)
    this.wetnessTextureA = device.createTexture({
      size: { width: this.textureWidth, height: this.textureHeight },
      format: "r32float",
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST,
      label: "Wetness Texture A",
    });
    this.wetnessTextureViewA = this.wetnessTextureA.createView();

    this.wetnessTextureB = device.createTexture({
      size: { width: this.textureWidth, height: this.textureHeight },
      format: "r32float",
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST,
      label: "Wetness Texture B",
    });
    this.wetnessTextureViewB = this.wetnessTextureB.createView();

    // Initialize textures to 0 (dry)
    this.clearTextures();

    // Bind groups will be created when we have water/terrain textures
    this.initialized = true;
  }

  /**
   * Clear wetness textures to initial state (dry).
   */
  private clearTextures(): void {
    const device = this.device;

    // Create a zeroed buffer to clear the textures
    const clearData = new Float32Array(this.textureWidth * this.textureHeight);
    const bytesPerRow = this.textureWidth * 4; // 4 bytes per f32

    if (this.wetnessTextureA) {
      device.queue.writeTexture(
        { texture: this.wetnessTextureA },
        clearData,
        { bytesPerRow },
        { width: this.textureWidth, height: this.textureHeight },
      );
    }

    if (this.wetnessTextureB) {
      device.queue.writeTexture(
        { texture: this.wetnessTextureB },
        clearData,
        { bytesPerRow },
        { width: this.textureWidth, height: this.textureHeight },
      );
    }
  }

  /**
   * Create bind groups for the given water and terrain textures.
   */
  private createBindGroups(
    waterTextureView: GPUTextureView,
    terrainTextureView: GPUTextureView,
  ): void {
    if (!this.shader || !this.paramsBuffer || !this.sampler) return;

    // Bind group A->B: read from A, write to B
    this.bindGroupAtoB = this.shader.createBindGroup({
      params: { buffer: this.paramsBuffer },
      prevWetnessTexture: this.wetnessTextureViewA!,
      waterTexture: waterTextureView,
      terrainTexture: terrainTextureView,
      textureSampler: this.sampler,
      outputTexture: this.wetnessTextureViewB!,
    });

    // Bind group B->A: read from B, write to A
    this.bindGroupBtoA = this.shader.createBindGroup({
      params: { buffer: this.paramsBuffer },
      prevWetnessTexture: this.wetnessTextureViewB!,
      waterTexture: waterTextureView,
      terrainTexture: terrainTextureView,
      textureSampler: this.sampler,
      outputTexture: this.wetnessTextureViewA!,
    });
  }

  /**
   * Update wetness texture with current state.
   *
   * The wetness texture shares its layout with the water/terrain textures
   * (same size, same screen-aligned expanded-viewport mapping), so current
   * texel UV reads directly into water/terrain. Reprojection uses the stored
   * previous-frame transform.
   *
   * @param texClipToWorld - Current frame's clip→world for the wetness texture
   * @param worldToTexClip - Current frame's world→clip (inverse of above)
   */
  @profile
  update(
    texClipToWorld: Matrix3,
    worldToTexClip: Matrix3,
    waterTextureView: GPUTextureView,
    terrainTextureView: GPUTextureView,
    dt: number,
    gpuProfiler?: GPUProfiler | null,
  ): void {
    if (!this.initialized || !this.shader || !this.paramsBuffer) {
      return;
    }

    const device = this.device;

    // Recreate bind groups (textures may have changed)
    this.createBindGroups(waterTextureView, terrainTextureView);

    if (!this.bindGroupAtoB || !this.bindGroupBtoA) return;

    // Use current transform as prev on first frame.
    const prevWorldToTexClip = this.prevWorldToTexClip ?? worldToTexClip;

    // Update params buffer
    this.uniforms.set.currentTexClipToWorld(texClipToWorld);
    this.uniforms.set.prevWorldToTexClip(prevWorldToTexClip);
    this.uniforms.set.dt(dt);
    this.uniforms.set.wettingRate(this.wettingRate);
    this.uniforms.set.dryingRate(this.dryingRate);
    this.uniforms.set.textureSizeX(this.textureWidth);
    this.uniforms.set.textureSizeY(this.textureHeight);

    this.uniforms.uploadTo(this.paramsBuffer);

    // Select bind group based on current read texture
    const bindGroup =
      this.currentReadTexture === "A" ? this.bindGroupAtoB : this.bindGroupBtoA;

    // Create command encoder
    const commandEncoder = device.createCommandEncoder({
      label: "Wetness Render Compute Encoder",
    });

    const computePass = commandEncoder.beginComputePass({
      label: "Wetness Render Compute Pass",
      timestampWrites:
        gpuProfiler?.getComputeTimestampWrites("surface.wetness"),
    });

    this.shader.dispatch(
      computePass,
      bindGroup,
      this.textureWidth,
      this.textureHeight,
    );

    computePass.end();

    // Submit
    device.queue.submit([commandEncoder.finish()]);

    // Swap textures for next frame
    this.currentReadTexture = this.currentReadTexture === "A" ? "B" : "A";

    // Store world→clip for next frame's reprojection.
    this.prevWorldToTexClip = worldToTexClip.clone();
  }

  /**
   * Get the output texture view for rendering.
   * Returns the texture that was just written to.
   */
  getOutputTextureView(): GPUTextureView | null {
    // After swap, currentReadTexture points to what we just wrote
    // So we return that one for rendering
    return this.currentReadTexture === "A"
      ? this.wetnessTextureViewA
      : this.wetnessTextureViewB;
  }

  /**
   * Get the texture width.
   */
  getTextureWidth(): number {
    return this.textureWidth;
  }

  /**
   * Get the texture height.
   */
  getTextureHeight(): number {
    return this.textureHeight;
  }

  /**
   * Check if the pipeline is initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Set wetness rates.
   */
  setWetnessRates(wettingRate: number, dryingRate: number): void {
    this.wettingRate = wettingRate;
    this.dryingRate = dryingRate;
  }

  /**
   * Clean up GPU resources.
   */
  destroy(): void {
    this.wetnessTextureA?.destroy();
    this.wetnessTextureB?.destroy();
    this.paramsBuffer?.destroy();
    this.shader?.destroy();

    this.wetnessTextureA = null;
    this.wetnessTextureB = null;
    this.wetnessTextureViewA = null;
    this.wetnessTextureViewB = null;
    this.paramsBuffer = null;
    this.sampler = null;
    this.bindGroupAtoB = null;
    this.bindGroupBtoA = null;
    this.shader = null;
    this.prevWorldToTexClip = null;
    this.initialized = false;
  }
}
