/**
 * Manages a fullscreen quad VAO for screen-space effects.
 * Provides a single position attribute covering clip space [-1,1].
 */
export class FullscreenQuad {
  private vao: WebGLVertexArrayObject;
  private vertexBuffer: WebGLBuffer;

  constructor(private gl: WebGL2RenderingContext) {
    const vao = gl.createVertexArray();
    const vertexBuffer = gl.createBuffer();
    if (!vao || !vertexBuffer) {
      throw new Error("Failed to create fullscreen quad resources");
    }
    this.vao = vao;
    this.vertexBuffer = vertexBuffer;

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);

    // Fullscreen quad vertices (two triangles covering clip space)
    const vertices = new Float32Array([
      -1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1,
    ]);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    gl.bindVertexArray(null);
  }

  /**
   * Bind the VAO and set up the position attribute for the given shader.
   */
  bind(positionAttribLocation: number): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.enableVertexAttribArray(positionAttribLocation);
    gl.vertexAttribPointer(positionAttribLocation, 2, gl.FLOAT, false, 0, 0);
  }

  /**
   * Draw the fullscreen quad (assumes VAO is bound).
   */
  draw(): void {
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
  }

  /**
   * Unbind the VAO.
   */
  unbind(): void {
    this.gl.bindVertexArray(null);
  }

  destroy(): void {
    const gl = this.gl;
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.vertexBuffer);
  }
}
