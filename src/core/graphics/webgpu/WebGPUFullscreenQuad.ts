/**
 * Static fullscreen quad for WebGPU fullscreen effects.
 * Provides a simple vertex buffer covering clip space from (-1,-1) to (1,1).
 */

import { getWebGPU } from "./WebGPUDevice";

/**
 * Fullscreen quad geometry for post-processing and fullscreen shaders.
 * Creates a quad that covers the entire clip space.
 */
export class WebGPUFullscreenQuad {
  private vertexBuffer: GPUBuffer;
  private indexBuffer: GPUBuffer;

  // Vertex data: position (x, y) only
  // Two triangles covering clip space
  static readonly VERTICES = new Float32Array([
    -1.0, -1.0, // bottom-left
    1.0, -1.0, // bottom-right
    1.0, 1.0, // top-right
    -1.0, 1.0, // top-left
  ]);

  static readonly INDICES = new Uint16Array([
    0, 1, 2, // first triangle
    0, 2, 3, // second triangle
  ]);

  constructor() {
    const device = getWebGPU().device;

    // Create vertex buffer
    this.vertexBuffer = device.createBuffer({
      size: WebGPUFullscreenQuad.VERTICES.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      label: "Fullscreen Quad Vertex Buffer",
      mappedAtCreation: true,
    });
    new Float32Array(this.vertexBuffer.getMappedRange()).set(
      WebGPUFullscreenQuad.VERTICES
    );
    this.vertexBuffer.unmap();

    // Create index buffer
    this.indexBuffer = device.createBuffer({
      size: WebGPUFullscreenQuad.INDICES.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      label: "Fullscreen Quad Index Buffer",
      mappedAtCreation: true,
    });
    new Uint16Array(this.indexBuffer.getMappedRange()).set(
      WebGPUFullscreenQuad.INDICES
    );
    this.indexBuffer.unmap();
  }

  /** Get the vertex buffer layout for pipeline creation */
  static getVertexBufferLayout(): GPUVertexBufferLayout {
    return {
      arrayStride: 2 * 4, // 2 floats * 4 bytes
      attributes: [
        {
          shaderLocation: 0,
          offset: 0,
          format: "float32x2",
        },
      ],
    };
  }

  /** Bind the vertex and index buffers to a render pass */
  bind(renderPass: GPURenderPassEncoder): void {
    renderPass.setVertexBuffer(0, this.vertexBuffer);
    renderPass.setIndexBuffer(this.indexBuffer, "uint16");
  }

  /** Draw the fullscreen quad (call after bind) */
  draw(renderPass: GPURenderPassEncoder): void {
    renderPass.drawIndexed(6);
  }

  /** Convenience method to bind and draw */
  render(renderPass: GPURenderPassEncoder): void {
    this.bind(renderPass);
    this.draw(renderPass);
  }

  destroy(): void {
    this.vertexBuffer.destroy();
    this.indexBuffer.destroy();
  }
}
