/**
 * Manages loading and caching of WebGPU textures.
 */

import { getWebGPU } from "./WebGPUDevice";

/** Represents a WebGPU texture with associated metadata */
export interface WebGPUTexture {
  /** The WebGPU texture object */
  texture: GPUTexture;
  /** The texture view for binding */
  view: GPUTextureView;
  /** Width in pixels */
  width: number;
  /** Height in pixels */
  height: number;
  /** Optional sampler (created lazily) */
  sampler?: GPUSampler;
}

/** Options for texture creation */
export interface TextureOptions {
  /** Texture format (default: rgba8unorm) */
  format?: GPUTextureFormat;
  /** Usage flags (default: TEXTURE_BINDING | COPY_DST) */
  usage?: GPUTextureUsageFlags;
  /** Whether to generate mipmaps (default: false) */
  mipmaps?: boolean;
  /** Debug label */
  label?: string;
}

/** Sampler filter mode */
export type FilterMode = "nearest" | "linear";

/** Sampler address mode */
export type AddressMode = "clamp-to-edge" | "repeat" | "mirror-repeat";

/**
 * Manages loading and caching of WebGPU textures.
 */
export class WebGPUTextureManager {
  /** Cache of loaded textures by URL */
  private cache: Map<string, WebGPUTexture> = new Map();

  /** Pending loads */
  private pending: Map<string, Promise<WebGPUTexture>> = new Map();

  /** Cached samplers by configuration key */
  private samplers: Map<string, GPUSampler> = new Map();

  /** Default sampler for most textures */
  private defaultSampler: GPUSampler | null = null;

  constructor() {
    // Initialize default sampler lazily
  }

  /** Get or create the default linear sampler */
  getDefaultSampler(): GPUSampler {
    if (!this.defaultSampler) {
      this.defaultSampler = this.createSampler("linear", "clamp-to-edge");
    }
    return this.defaultSampler;
  }

  /**
   * Create a sampler with the specified configuration.
   * Samplers are cached and reused.
   */
  createSampler(
    filter: FilterMode = "linear",
    addressMode: AddressMode = "clamp-to-edge",
  ): GPUSampler {
    const key = `${filter}-${addressMode}`;
    let sampler = this.samplers.get(key);

    if (!sampler) {
      const device = getWebGPU().device;
      const filterMode = filter === "linear" ? "linear" : "nearest";
      const wrapMode = addressMode as GPUAddressMode;

      sampler = device.createSampler({
        magFilter: filterMode,
        minFilter: filterMode,
        mipmapFilter: filterMode,
        addressModeU: wrapMode,
        addressModeV: wrapMode,
        addressModeW: wrapMode,
      });

      this.samplers.set(key, sampler);
    }

    return sampler;
  }

  /**
   * Load a texture from a URL.
   * Returns a cached texture if already loaded.
   */
  async load(url: string, options?: TextureOptions): Promise<WebGPUTexture> {
    // Check cache
    const cached = this.cache.get(url);
    if (cached) {
      return cached;
    }

    // Check if already loading
    const pendingLoad = this.pending.get(url);
    if (pendingLoad) {
      return pendingLoad;
    }

    // Start loading
    const loadPromise = this.loadImage(url, options);
    this.pending.set(url, loadPromise);

    try {
      const texture = await loadPromise;
      this.cache.set(url, texture);
      return texture;
    } finally {
      this.pending.delete(url);
    }
  }

  /**
   * Load a texture synchronously from an already-loaded image.
   */
  fromImage(
    image: HTMLImageElement | ImageBitmap,
    options?: TextureOptions,
  ): WebGPUTexture {
    const device = getWebGPU().device;

    const format = options?.format ?? "rgba8unorm";
    const usage =
      options?.usage ??
      GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT;

    const texture = device.createTexture({
      size: { width: image.width, height: image.height },
      format,
      usage,
      label: options?.label,
    });

    // Copy image data to texture
    device.queue.copyExternalImageToTexture(
      { source: image },
      { texture },
      { width: image.width, height: image.height },
    );

    const view = texture.createView();

    return {
      texture,
      view,
      width: image.width,
      height: image.height,
      sampler: this.getDefaultSampler(),
    };
  }

  /**
   * Create a texture from a canvas.
   */
  fromCanvas(
    canvas: HTMLCanvasElement,
    options?: TextureOptions,
  ): WebGPUTexture {
    const device = getWebGPU().device;

    const format = options?.format ?? "rgba8unorm";
    const usage =
      options?.usage ??
      GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT;

    const texture = device.createTexture({
      size: { width: canvas.width, height: canvas.height },
      format,
      usage,
      label: options?.label,
    });

    // Copy canvas data to texture
    device.queue.copyExternalImageToTexture(
      { source: canvas },
      { texture },
      { width: canvas.width, height: canvas.height },
    );

    const view = texture.createView();

    return {
      texture,
      view,
      width: canvas.width,
      height: canvas.height,
      sampler: this.getDefaultSampler(),
    };
  }

  /**
   * Create an empty texture of the specified size.
   */
  createEmpty(
    width: number,
    height: number,
    options?: TextureOptions,
  ): WebGPUTexture {
    const device = getWebGPU().device;

    const format = options?.format ?? "rgba8unorm";
    const usage =
      options?.usage ??
      GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT;

    const texture = device.createTexture({
      size: { width, height },
      format,
      usage,
      label: options?.label,
    });

    const view = texture.createView();

    return {
      texture,
      view,
      width,
      height,
      sampler: this.getDefaultSampler(),
    };
  }

  /**
   * Create a render target texture (for off-screen rendering).
   */
  createRenderTarget(
    width: number,
    height: number,
    format: GPUTextureFormat = "rgba16float",
    label?: string,
  ): WebGPUTexture {
    const device = getWebGPU().device;

    const texture = device.createTexture({
      size: { width, height },
      format,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC,
      label,
    });

    const view = texture.createView();

    return {
      texture,
      view,
      width,
      height,
      sampler: this.getDefaultSampler(),
    };
  }

  /**
   * Create a storage texture (for compute shader output).
   */
  createStorageTexture(
    width: number,
    height: number,
    format: GPUTextureFormat = "rgba16float",
    label?: string,
  ): WebGPUTexture {
    const device = getWebGPU().device;

    const texture = device.createTexture({
      size: { width, height },
      format,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.COPY_SRC,
      label,
    });

    const view = texture.createView();

    return {
      texture,
      view,
      width,
      height,
      sampler: this.getDefaultSampler(),
    };
  }

  /**
   * Create a texture from raw pixel data.
   */
  fromPixels(
    data: Uint8Array,
    width: number,
    height: number,
    options?: TextureOptions,
  ): WebGPUTexture {
    const device = getWebGPU().device;

    const format = options?.format ?? "rgba8unorm";
    const usage =
      options?.usage ??
      GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT;

    const texture = device.createTexture({
      size: { width, height },
      format,
      usage,
      label: options?.label,
    });

    // Upload pixel data
    device.queue.writeTexture(
      { texture },
      data.buffer,
      { bytesPerRow: width * 4, rowsPerImage: height },
      { width, height },
    );

    const view = texture.createView();

    return {
      texture,
      view,
      width,
      height,
      sampler: this.getDefaultSampler(),
    };
  }

  /**
   * Update a texture with new pixel data.
   */
  updateTexture(tex: WebGPUTexture, data: Uint8Array): void {
    const device = getWebGPU().device;

    device.queue.writeTexture(
      { texture: tex.texture },
      data.buffer,
      { bytesPerRow: tex.width * 4, rowsPerImage: tex.height },
      { width: tex.width, height: tex.height },
    );
  }

  /**
   * Create a 1x1 white texture (useful as default).
   */
  createWhiteTexture(): WebGPUTexture {
    return this.fromPixels(new Uint8Array([255, 255, 255, 255]), 1, 1);
  }

  /**
   * Delete a texture and free its resources.
   */
  delete(tex: WebGPUTexture): void {
    tex.texture.destroy();

    // Remove from cache if present
    for (const [url, cached] of this.cache.entries()) {
      if (cached === tex) {
        this.cache.delete(url);
        break;
      }
    }
  }

  /**
   * Clear all cached textures.
   */
  clearCache(): void {
    for (const tex of this.cache.values()) {
      tex.texture.destroy();
    }
    this.cache.clear();
  }

  /**
   * Clean up all resources.
   */
  destroy(): void {
    this.clearCache();
    this.samplers.clear();
    this.defaultSampler = null;
  }

  /**
   * Get the number of cached textures.
   */
  getTextureCount(): number {
    return this.cache.size;
  }

  /**
   * Load an image from URL and create a texture.
   */
  private async loadImage(
    url: string,
    options?: TextureOptions,
  ): Promise<WebGPUTexture> {
    const response = await fetch(url);
    const blob = await response.blob();
    const imageBitmap = await createImageBitmap(blob);

    return this.fromImage(imageBitmap, {
      ...options,
      label: options?.label ?? url,
    });
  }
}
