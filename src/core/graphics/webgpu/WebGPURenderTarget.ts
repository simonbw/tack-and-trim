/**
 * WebGPU render target for off-screen rendering.
 * Supports rendering to texture and reading back results.
 */

import { getWebGPU } from "./WebGPUDevice";

/**
 * Options for creating a render target.
 */
export interface RenderTargetOptions {
  /** Texture format (default: rgba16float) */
  format?: GPUTextureFormat;
  /** Debug label */
  label?: string;
  /** Whether to create a depth/stencil attachment (default: false) */
  depth?: boolean;
}

/**
 * A render target texture that can be rendered to and sampled from.
 * Used for off-screen rendering, post-processing, and compute shader output.
 */
export class WebGPURenderTarget {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly width: number;
  readonly height: number;
  readonly format: GPUTextureFormat;

  private depthTexture: GPUTexture | null = null;
  private depthView: GPUTextureView | null = null;

  /** Sampler for reading from this texture */
  private _sampler: GPUSampler | null = null;

  constructor(
    width: number,
    height: number,
    options: RenderTargetOptions = {},
  ) {
    const device = getWebGPU().device;

    this.width = width;
    this.height = height;
    this.format = options.format ?? "rgba16float";

    // Create the main color texture
    this.texture = device.createTexture({
      size: { width, height },
      format: this.format,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
      label: options.label ?? "Render Target",
    });

    this.view = this.texture.createView();

    // Optionally create depth attachment
    if (options.depth) {
      this.depthTexture = device.createTexture({
        size: { width, height },
        format: "depth24plus",
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
        label: `${options.label ?? "Render Target"} Depth`,
      });
      this.depthView = this.depthTexture.createView();
    }
  }

  /** Get a sampler for reading from this texture */
  get sampler(): GPUSampler {
    if (!this._sampler) {
      const device = getWebGPU().device;
      this._sampler = device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
      });
    }
    return this._sampler;
  }

  /**
   * Get a render pass descriptor for rendering to this target.
   */
  getRenderPassDescriptor(clearColor?: {
    r: number;
    g: number;
    b: number;
    a: number;
  }): GPURenderPassDescriptor {
    const colorAttachment: GPURenderPassColorAttachment = {
      view: this.view,
      loadOp: clearColor ? "clear" : "load",
      storeOp: "store",
    };

    if (clearColor) {
      colorAttachment.clearValue = clearColor;
    }

    const descriptor: GPURenderPassDescriptor = {
      colorAttachments: [colorAttachment],
    };

    if (this.depthView) {
      descriptor.depthStencilAttachment = {
        view: this.depthView,
        depthLoadOp: "clear",
        depthStoreOp: "store",
        depthClearValue: 1.0,
      };
    }

    return descriptor;
  }

  /**
   * Begin a render pass to this target.
   */
  beginRenderPass(
    commandEncoder: GPUCommandEncoder,
    clearColor?: { r: number; g: number; b: number; a: number },
  ): GPURenderPassEncoder {
    return commandEncoder.beginRenderPass(
      this.getRenderPassDescriptor(clearColor),
    );
  }

  /**
   * Read pixel data from this render target.
   * This is an async operation that copies from GPU to CPU.
   */
  async readPixels(): Promise<Float32Array> {
    const device = getWebGPU().device;

    // Calculate bytes per row (must be multiple of 256 for WebGPU)
    const bytesPerPixel = this.getBytesPerPixel();
    const unpaddedBytesPerRow = this.width * bytesPerPixel;
    const paddedBytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;

    // Create staging buffer
    const bufferSize = paddedBytesPerRow * this.height;
    const stagingBuffer = device.createBuffer({
      size: bufferSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      label: "Render Target Readback Buffer",
    });

    // Copy texture to buffer
    const commandEncoder = device.createCommandEncoder();
    commandEncoder.copyTextureToBuffer(
      { texture: this.texture },
      { buffer: stagingBuffer, bytesPerRow: paddedBytesPerRow },
      { width: this.width, height: this.height },
    );
    device.queue.submit([commandEncoder.finish()]);

    // Map and read data
    await stagingBuffer.mapAsync(GPUMapMode.READ);
    const mappedRange = stagingBuffer.getMappedRange();

    // Copy data, handling row padding
    const result = new Float32Array(this.width * this.height * 4);
    const paddedData = new Float32Array(mappedRange);

    for (let y = 0; y < this.height; y++) {
      const srcOffset = (y * paddedBytesPerRow) / 4;
      const dstOffset = y * this.width * 4;
      result.set(
        paddedData.subarray(srcOffset, srcOffset + this.width * 4),
        dstOffset,
      );
    }

    stagingBuffer.unmap();
    stagingBuffer.destroy();

    return result;
  }

  /**
   * Read a region of pixel data from this render target.
   */
  async readRegion(
    x: number,
    y: number,
    width: number,
    height: number,
  ): Promise<Float32Array> {
    const device = getWebGPU().device;

    const bytesPerPixel = this.getBytesPerPixel();
    const unpaddedBytesPerRow = width * bytesPerPixel;
    const paddedBytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;

    const bufferSize = paddedBytesPerRow * height;
    const stagingBuffer = device.createBuffer({
      size: bufferSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      label: "Render Target Region Readback Buffer",
    });

    const commandEncoder = device.createCommandEncoder();
    commandEncoder.copyTextureToBuffer(
      { texture: this.texture, origin: { x, y } },
      { buffer: stagingBuffer, bytesPerRow: paddedBytesPerRow },
      { width, height },
    );
    device.queue.submit([commandEncoder.finish()]);

    await stagingBuffer.mapAsync(GPUMapMode.READ);
    const mappedRange = stagingBuffer.getMappedRange();

    const result = new Float32Array(width * height * 4);
    const paddedData = new Float32Array(mappedRange);

    for (let row = 0; row < height; row++) {
      const srcOffset = (row * paddedBytesPerRow) / 4;
      const dstOffset = row * width * 4;
      result.set(
        paddedData.subarray(srcOffset, srcOffset + width * 4),
        dstOffset,
      );
    }

    stagingBuffer.unmap();
    stagingBuffer.destroy();

    return result;
  }

  private getBytesPerPixel(): number {
    switch (this.format) {
      case "rgba16float":
        return 8; // 4 channels * 2 bytes
      case "rgba32float":
        return 16; // 4 channels * 4 bytes
      case "rgba8unorm":
      case "bgra8unorm":
        return 4; // 4 channels * 1 byte
      default:
        return 4;
    }
  }

  destroy(): void {
    this.texture.destroy();
    this.depthTexture?.destroy();
  }
}
