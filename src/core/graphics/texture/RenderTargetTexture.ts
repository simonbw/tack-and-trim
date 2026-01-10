/**
 * Base class for GPU render target textures (framebuffer objects).
 *
 * Manages a WebGL texture attached to a framebuffer, allowing shaders to
 * render directly to the texture. Supports RGBA16F format with automatic
 * fallback to RGBA8 if the platform doesn't support float render targets.
 *
 * Usage:
 *   target.bind();      // Start rendering to this texture
 *   // ... draw calls ...
 *   target.unbind();    // Return to default framebuffer
 *   target.getTexture() // Sample in other shaders
 */
export class RenderTargetTexture {
  protected gl: WebGL2RenderingContext;
  protected framebuffer: WebGLFramebuffer | null = null;
  protected texture: WebGLTexture | null = null;
  protected width: number;
  protected height: number;
  protected useFloat16: boolean;

  constructor(
    gl: WebGL2RenderingContext,
    width: number,
    height: number,
    preferFloat16: boolean = true,
  ) {
    this.gl = gl;
    this.width = width;
    this.height = height;

    // Check for float render target support
    if (preferFloat16) {
      const ext = gl.getExtension("EXT_color_buffer_half_float");
      this.useFloat16 = ext !== null;
    } else {
      this.useFloat16 = false;
    }

    this.createResources();
  }

  private createResources(): void {
    const gl = this.gl;

    // Create texture
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);

    // Standard texture parameters
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Allocate texture with appropriate format
    if (this.useFloat16) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA16F,
        this.width,
        this.height,
        0,
        gl.RGBA,
        gl.HALF_FLOAT,
        null,
      );
    } else {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        this.width,
        this.height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
    }

    // Create framebuffer
    this.framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);

    // Attach texture as color attachment
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.texture,
      0,
    );

    // Check framebuffer completeness
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      console.error(`Framebuffer not complete: ${status}`);

      // Try falling back to RGBA8 if RGBA16F failed
      if (this.useFloat16) {
        console.warn("RGBA16F framebuffer failed, falling back to RGBA8");
        this.useFloat16 = false;
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          this.width,
          this.height,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          null,
        );

        const status2 = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status2 !== gl.FRAMEBUFFER_COMPLETE) {
          throw new Error(
            `Framebuffer still not complete after fallback: ${status2}`,
          );
        }
      }
    }

    // Unbind
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /**
   * Bind this framebuffer for rendering.
   * Sets the viewport to match texture dimensions.
   */
  bind(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
  }

  /**
   * Unbind the framebuffer, returning to the default framebuffer.
   * Note: Does not restore viewport - caller must handle that.
   */
  unbind(): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
  }

  /**
   * Get the texture for sampling in other shaders.
   */
  getTexture(): WebGLTexture | null {
    return this.texture;
  }

  /**
   * Get texture dimensions.
   */
  getWidth(): number {
    return this.width;
  }

  getHeight(): number {
    return this.height;
  }

  /**
   * Check if using RGBA16F format.
   */
  isFloat16(): boolean {
    return this.useFloat16;
  }

  /**
   * Resize the texture (recreates resources).
   */
  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) {
      return;
    }
    this.width = width;
    this.height = height;
    this.destroy();
    this.createResources();
  }

  /**
   * Clean up WebGL resources.
   */
  destroy(): void {
    const gl = this.gl;
    if (this.framebuffer) {
      gl.deleteFramebuffer(this.framebuffer);
      this.framebuffer = null;
    }
    if (this.texture) {
      gl.deleteTexture(this.texture);
      this.texture = null;
    }
  }
}
