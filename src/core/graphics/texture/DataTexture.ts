/**
 * Base class for CPU-updated textures.
 *
 * Manages a WebGL texture backed by a CPU-side pixel buffer (Uint8Array).
 * Subclasses populate the pixel buffer and call upload() to send data to GPU.
 *
 * Common texture parameters (LINEAR filtering, CLAMP_TO_EDGE wrapping) are
 * set automatically during initialization.
 */
export abstract class DataTexture {
  protected gl: WebGL2RenderingContext | null = null;
  protected texture: WebGLTexture | null = null;
  protected pixels: Uint8Array;
  protected readonly textureWidth: number;
  protected readonly textureHeight: number;

  constructor(width: number, height: number) {
    this.textureWidth = width;
    this.textureHeight = height;
    // RGBA8 format: 4 bytes per pixel
    this.pixels = new Uint8Array(width * height * 4);
  }

  /**
   * Initialize WebGL resources. Must be called with the GL context.
   */
  initGL(gl: WebGL2RenderingContext): void {
    this.gl = gl;

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);

    // Standard texture parameters
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Initialize texture storage
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      this.textureWidth,
      this.textureHeight,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.pixels,
    );

    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /**
   * Upload the current pixel buffer to the GPU.
   * Call this after modifying the pixels array.
   */
  protected upload(): void {
    if (!this.gl || !this.texture) return;

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      this.textureWidth,
      this.textureHeight,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.pixels,
    );
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /**
   * Get the WebGL texture for binding in shaders.
   */
  getTexture(): WebGLTexture | null {
    return this.texture;
  }

  /**
   * Get texture dimensions.
   */
  getWidth(): number {
    return this.textureWidth;
  }

  getHeight(): number {
    return this.textureHeight;
  }

  /**
   * Clean up WebGL resources.
   */
  destroy(): void {
    if (this.gl && this.texture) {
      this.gl.deleteTexture(this.texture);
      this.texture = null;
    }
  }
}
