/**
 * Represents a WebGL texture with associated metadata.
 */
export interface Texture {
  /** The WebGL texture object */
  glTexture: WebGLTexture;
  /** Width in pixels */
  width: number;
  /** Height in pixels */
  height: number;
}

/**
 * Manages loading and caching of WebGL textures.
 */
export class TextureManager {
  /** Cache of loaded textures by URL */
  private cache: Map<string, Texture> = new Map();

  /** Pending loads */
  private pending: Map<string, Promise<Texture>> = new Map();

  constructor(private gl: WebGL2RenderingContext) {}

  /**
   * Load a texture from a URL.
   * Returns a cached texture if already loaded.
   */
  async load(url: string): Promise<Texture> {
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
    const loadPromise = this.loadImage(url);
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
  fromImage(image: HTMLImageElement): Texture {
    const gl = this.gl;
    const glTexture = gl.createTexture();
    if (!glTexture) {
      throw new Error("Failed to create texture");
    }

    gl.bindTexture(gl.TEXTURE_2D, glTexture);

    // Set texture parameters
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // Upload image data
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);

    return {
      glTexture,
      width: image.width,
      height: image.height,
    };
  }

  /**
   * Create a texture from a canvas.
   */
  fromCanvas(canvas: HTMLCanvasElement): Texture {
    const gl = this.gl;
    const glTexture = gl.createTexture();
    if (!glTexture) {
      throw new Error("Failed to create texture");
    }

    gl.bindTexture(gl.TEXTURE_2D, glTexture);

    // Set texture parameters
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // Upload canvas data
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);

    return {
      glTexture,
      width: canvas.width,
      height: canvas.height,
    };
  }

  /**
   * Create an empty texture of the specified size.
   */
  createEmpty(width: number, height: number): Texture {
    const gl = this.gl;
    const glTexture = gl.createTexture();
    if (!glTexture) {
      throw new Error("Failed to create texture");
    }

    gl.bindTexture(gl.TEXTURE_2D, glTexture);

    // Set texture parameters
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // Create empty texture
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );

    return {
      glTexture,
      width,
      height,
    };
  }

  /**
   * Create a texture from raw pixel data.
   */
  fromPixels(
    data: Uint8Array,
    width: number,
    height: number,
    format: "RGBA" | "RGB" = "RGBA",
  ): Texture {
    const gl = this.gl;
    const glTexture = gl.createTexture();
    if (!glTexture) {
      throw new Error("Failed to create texture");
    }

    gl.bindTexture(gl.TEXTURE_2D, glTexture);

    // Set texture parameters
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const glFormat = format === "RGBA" ? gl.RGBA : gl.RGB;

    // Upload pixel data
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      glFormat,
      width,
      height,
      0,
      glFormat,
      gl.UNSIGNED_BYTE,
      data,
    );

    return {
      glTexture,
      width,
      height,
    };
  }

  /**
   * Update a texture with new pixel data.
   */
  updateTexture(
    texture: Texture,
    data: Uint8Array,
    format: "RGBA" | "RGB" = "RGBA",
  ): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, texture.glTexture);

    const glFormat = format === "RGBA" ? gl.RGBA : gl.RGB;

    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      texture.width,
      texture.height,
      glFormat,
      gl.UNSIGNED_BYTE,
      data,
    );
  }

  /**
   * Create a 1x1 white texture (useful as default).
   */
  createWhiteTexture(): Texture {
    return this.fromPixels(new Uint8Array([255, 255, 255, 255]), 1, 1);
  }

  /**
   * Delete a texture and free its resources.
   */
  delete(texture: Texture): void {
    this.gl.deleteTexture(texture.glTexture);

    // Remove from cache if present
    for (const [url, cached] of this.cache.entries()) {
      if (cached === texture) {
        this.cache.delete(url);
        break;
      }
    }
  }

  /**
   * Clear all cached textures.
   */
  clearCache(): void {
    for (const texture of this.cache.values()) {
      this.gl.deleteTexture(texture.glTexture);
    }
    this.cache.clear();
  }

  /**
   * Clean up all resources.
   */
  destroy(): void {
    this.clearCache();
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
  private async loadImage(url: string): Promise<Texture> {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = "anonymous";

      image.onload = () => {
        try {
          const texture = this.fromImage(image);
          resolve(texture);
        } catch (error) {
          reject(error);
        }
      };

      image.onerror = () => {
        reject(new Error(`Failed to load image: ${url}`));
      };

      image.src = url;
    });
  }
}
