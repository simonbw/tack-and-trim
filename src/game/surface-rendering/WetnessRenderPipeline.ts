/**
 * Wetness rendering compute pipeline.
 *
 * Tracks sand wetness over time using ping-pong textures.
 * When waves wash over sand, it becomes wet. When water recedes,
 * sand slowly dries out.
 *
 * Uses reprojection to maintain wetness state as the camera moves.
 */

import {
  GPUProfiler,
  GPUProfileSection,
} from "../../core/graphics/webgpu/GPUProfiler";
import { getWebGPU } from "../../core/graphics/webgpu/WebGPUDevice";
import { profile } from "../../core/util/Profiler";
import type { Viewport } from "../world-data/water/WaterInfo";
import { WETNESS_TEXTURE_SIZE } from "./SurfaceRenderer";
import {
  DEFAULT_DRYING_RATE,
  DEFAULT_WETTING_RATE,
  WetnessStateShader,
} from "./WetnessStateShader";

/**
 * Wetness rendering compute pipeline using ping-pong textures.
 */
export class WetnessRenderPipeline {
  private shader: WetnessStateShader | null = null;

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

  // Track previous viewport for reprojection
  private prevViewport: Viewport | null = null;

  // Uniform buffer for shader params
  private paramsBuffer: GPUBuffer | null = null;
  private paramsData = new Float32Array(16); // dt, wettingRate, dryingRate, textureSize, current viewport (4), prev viewport (4), render viewport (4)

  // Sampler for texture sampling
  private sampler: GPUSampler | null = null;

  private textureSize: number;
  private initialized = false;

  // Configurable rates
  private wettingRate = DEFAULT_WETTING_RATE;
  private dryingRate = DEFAULT_DRYING_RATE;

  // Track the last snapped viewport for returning to caller
  private lastSnappedViewport: Viewport | null = null;

  constructor(textureSize: number = WETNESS_TEXTURE_SIZE) {
    this.textureSize = textureSize;
  }

  /**
   * Snap viewport to texel grid to ensure 1:1 texel mapping between frames.
   * This prevents blur from sub-pixel sampling during reprojection.
   */
  private snapViewportToGrid(viewport: Viewport): Viewport {
    const texelWorldSize = viewport.width / this.textureSize;

    return {
      left: Math.floor(viewport.left / texelWorldSize) * texelWorldSize,
      top: Math.floor(viewport.top / texelWorldSize) * texelWorldSize,
      width: viewport.width,
      height: viewport.height,
    };
  }

  /**
   * Initialize WebGPU resources.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    const device = getWebGPU().device;

    // Initialize compute shader
    this.shader = new WetnessStateShader();
    await this.shader.init();

    // Create params buffer
    this.paramsBuffer = device.createBuffer({
      size: this.paramsData.byteLength,
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
      size: { width: this.textureSize, height: this.textureSize },
      format: "r32float",
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST,
      label: "Wetness Texture A",
    });
    this.wetnessTextureViewA = this.wetnessTextureA.createView();

    this.wetnessTextureB = device.createTexture({
      size: { width: this.textureSize, height: this.textureSize },
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
    const device = getWebGPU().device;

    // Create a zeroed buffer to clear the textures
    const clearData = new Float32Array(this.textureSize * this.textureSize);
    const bytesPerRow = this.textureSize * 4; // 4 bytes per f32

    if (this.wetnessTextureA) {
      device.queue.writeTexture(
        { texture: this.wetnessTextureA },
        clearData,
        { bytesPerRow },
        { width: this.textureSize, height: this.textureSize },
      );
    }

    if (this.wetnessTextureB) {
      device.queue.writeTexture(
        { texture: this.wetnessTextureB },
        clearData,
        { bytesPerRow },
        { width: this.textureSize, height: this.textureSize },
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
   * Update wetness texture with current state for the given viewport.
   * @param wetnessViewport - The viewport for wetness computation (larger margin)
   * @param renderViewport - The viewport used for water/terrain textures (smaller margin)
   */
  @profile
  update(
    wetnessViewport: Viewport,
    renderViewport: Viewport,
    waterTextureView: GPUTextureView,
    terrainTextureView: GPUTextureView,
    dt: number,
    gpuProfiler?: GPUProfiler | null,
    section: GPUProfileSection = "wetnessCompute",
  ): void {
    if (!this.initialized || !this.shader || !this.paramsBuffer) {
      return;
    }

    const device = getWebGPU().device;

    // Snap wetness viewport to texel grid for 1:1 texel mapping between frames
    const snappedViewport = this.snapViewportToGrid(wetnessViewport);
    this.lastSnappedViewport = snappedViewport;

    // Recreate bind groups (textures may have changed)
    // In a more optimized version, we'd track if textures changed
    this.createBindGroups(waterTextureView, terrainTextureView);

    if (!this.bindGroupAtoB || !this.bindGroupBtoA) return;

    // Use current snapped viewport as prev if this is the first frame
    const prevViewport = this.prevViewport ?? snappedViewport;

    // Update params buffer
    this.paramsData[0] = dt;
    this.paramsData[1] = this.wettingRate;
    this.paramsData[2] = this.dryingRate;
    this.paramsData[3] = this.textureSize;
    // Current wetness viewport (snapped to grid)
    this.paramsData[4] = snappedViewport.left;
    this.paramsData[5] = snappedViewport.top;
    this.paramsData[6] = snappedViewport.width;
    this.paramsData[7] = snappedViewport.height;
    // Previous wetness viewport
    this.paramsData[8] = prevViewport.left;
    this.paramsData[9] = prevViewport.top;
    this.paramsData[10] = prevViewport.width;
    this.paramsData[11] = prevViewport.height;
    // Render viewport (for sampling water/terrain textures)
    this.paramsData[12] = renderViewport.left;
    this.paramsData[13] = renderViewport.top;
    this.paramsData[14] = renderViewport.width;
    this.paramsData[15] = renderViewport.height;

    device.queue.writeBuffer(this.paramsBuffer, 0, this.paramsData);

    // Select bind group based on current read texture
    const bindGroup =
      this.currentReadTexture === "A" ? this.bindGroupAtoB : this.bindGroupBtoA;

    // Create command encoder
    const commandEncoder = device.createCommandEncoder({
      label: "Wetness Render Compute Encoder",
    });

    // Begin compute pass with optional timestamp writes
    const computePass = commandEncoder.beginComputePass({
      label: "Wetness Render Compute Pass",
      timestampWrites: gpuProfiler?.getComputeTimestampWrites(section),
    });

    this.shader.dispatch(computePass, bindGroup, this.textureSize);

    computePass.end();

    // Submit
    device.queue.submit([commandEncoder.finish()]);

    // Swap textures for next frame
    this.currentReadTexture = this.currentReadTexture === "A" ? "B" : "A";

    // Store snapped viewport for next frame's reprojection (ensures 1:1 texel mapping)
    this.prevViewport = { ...snappedViewport };
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
   * Get the texture size.
   */
  getTextureSize(): number {
    return this.textureSize;
  }

  /**
   * Get the snapped viewport used for the last update.
   * This should be used by the display shader to correctly map UV coordinates.
   */
  getSnappedViewport(): Viewport | null {
    return this.lastSnappedViewport;
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
    this.prevViewport = null;
    this.initialized = false;
  }
}
