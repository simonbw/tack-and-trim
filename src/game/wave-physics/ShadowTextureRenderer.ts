/**
 * Shadow Texture Renderer
 *
 * Renders shadow polygons to a texture using the GPU's native rasterizer.
 * This replaces the expensive per-pixel point-in-polygon testing with a
 * simple texture lookup.
 *
 * Output format: r8uint (8-bit unsigned integer)
 * - Value 0 = not in shadow
 * - Value 1+ = polygon index (identifies which shadow region the pixel is in)
 */

import { getWebGPU } from "../../core/graphics/webgpu/WebGPUDevice";
import { earClipTriangulate } from "../../core/util/Triangulate";
import type { Viewport } from "../world-data/water/WaterInfo";
import { ShadowTextureShader } from "./ShadowTextureShader";
import type { ShadowPolygonRenderData } from "./ShadowGeometry";

/** Maximum number of shadow polygons we can render */
const MAX_POLYGONS = 16;

/** Maximum vertices per polygon (4 base + coastline samples) */
const MAX_VERTICES_PER_POLYGON = 64;

/** Maximum total vertices in the vertex buffer */
const MAX_TOTAL_VERTICES = MAX_POLYGONS * MAX_VERTICES_PER_POLYGON * 3; // x3 for triangulation

/** Bytes per vertex: position (2 floats) + polygon index (1 u32) */
const BYTES_PER_VERTEX = 12;

/**
 * Manages rendering of shadow polygons to a texture.
 */
export class ShadowTextureRenderer {
  private texture: GPUTexture | null = null;
  private textureView: GPUTextureView | null = null;
  private renderPipeline: GPURenderPipeline | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private shadowDataBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;

  private textureWidth: number;
  private textureHeight: number;
  private initialized = false;

  // Current vertex count for this frame
  private vertexCount = 0;

  // Shader instance for code generation
  private shader: ShadowTextureShader;

  constructor(textureWidth: number, textureHeight: number) {
    this.textureWidth = textureWidth;
    this.textureHeight = textureHeight;
    this.shader = new ShadowTextureShader();
  }

  /**
   * Initialize GPU resources.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    const device = getWebGPU().device;

    // Create shadow attenuation texture (rg16float format)
    // R = swell wave attenuation, G = chop wave attenuation
    this.texture = device.createTexture({
      size: { width: this.textureWidth, height: this.textureHeight },
      format: "rg16float",
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      label: "Shadow Attenuation Texture",
    });
    this.textureView = this.texture.createView();

    // Create vertex buffer
    this.vertexBuffer = device.createBuffer({
      size: MAX_TOTAL_VERTICES * BYTES_PER_VERTEX,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      label: "Shadow Polygon Vertex Buffer",
    });

    // Create uniform buffer for viewport params
    this.uniformBuffer = device.createBuffer({
      size: 16, // 4 floats: left, top, width, height
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Shadow Texture Uniform Buffer",
    });

    // Create bind group layout
    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "read-only-storage" },
        },
      ],
      label: "Shadow Texture Bind Group Layout",
    });

    // Create shader module
    const shaderModule = device.createShaderModule({
      code: this.shader.getShaderCode(),
      label: "Shadow Texture Shader Module",
    });

    // Create pipeline layout
    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
      label: "Shadow Texture Pipeline Layout",
    });

    // Create render pipeline
    this.renderPipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
        buffers: [
          {
            arrayStride: BYTES_PER_VERTEX,
            attributes: [
              {
                // position: vec2<f32>
                shaderLocation: 0,
                offset: 0,
                format: "float32x2",
              },
              {
                // polygonIndex: u32
                shaderLocation: 1,
                offset: 8,
                format: "uint32",
              },
            ],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [
          {
            format: "rg16float",
            blend: {
              color: {
                operation: "min",
                srcFactor: "one",
                dstFactor: "one",
              },
              alpha: {
                operation: "min",
                srcFactor: "one",
                dstFactor: "one",
              },
            },
          },
        ],
      },
      primitive: {
        topology: "triangle-list",
        cullMode: "none",
      },
      label: "Shadow Texture Render Pipeline",
    });

    this.initialized = true;
  }

  /**
   * Render shadow polygons for the current viewport.
   *
   * @param viewport - The viewport to render shadows for
   * @param polygons - Shadow polygon data from WavePhysicsManager (pre-computed vertices)
   * @param shadowDataBuffer - GPU buffer containing shadow polygon parameters
   */
  render(
    viewport: Viewport,
    polygons: ShadowPolygonRenderData[],
    shadowDataBuffer: GPUBuffer,
  ): void {
    if (
      !this.initialized ||
      !this.renderPipeline ||
      !this.vertexBuffer ||
      !this.uniformBuffer ||
      !this.bindGroupLayout ||
      !this.texture ||
      !this.textureView
    ) {
      return;
    }

    const device = getWebGPU().device;

    // Update shadow data buffer reference if changed
    if (this.shadowDataBuffer !== shadowDataBuffer) {
      this.shadowDataBuffer = shadowDataBuffer;

      // Recreate bind group with new shadow data buffer
      this.bindGroup = device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
          {
            binding: 0,
            resource: { buffer: this.uniformBuffer },
          },
          {
            binding: 1,
            resource: { buffer: this.shadowDataBuffer },
          },
        ],
        label: "Shadow Texture Bind Group",
      });
    }

    if (!this.bindGroup) {
      return;
    }

    // Update uniform buffer with viewport
    const uniformData = new Float32Array([
      viewport.left,
      viewport.top,
      viewport.width,
      viewport.height,
    ]);
    device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

    // Build vertex data for all polygons (uses pre-computed polygon.vertices)
    const vertices = this.buildVertexData(polygons);
    this.vertexCount = vertices.length / 3; // 3 floats per vertex (x, y, index as float)

    if (this.vertexCount === 0) {
      // No polygons to render - clear texture to 0
      this.clearTexture();
      return;
    }

    // Upload vertex data
    const vertexData = new ArrayBuffer(this.vertexCount * BYTES_PER_VERTEX);
    const floatView = new Float32Array(vertexData);
    const uintView = new Uint32Array(vertexData);

    for (let i = 0; i < this.vertexCount; i++) {
      floatView[i * 3 + 0] = vertices[i * 3 + 0]; // x
      floatView[i * 3 + 1] = vertices[i * 3 + 1]; // y
      uintView[i * 3 + 2] = vertices[i * 3 + 2]; // polygon index (as u32)
    }

    device.queue.writeBuffer(this.vertexBuffer, 0, vertexData);

    // Create command encoder
    const commandEncoder = device.createCommandEncoder({
      label: "Shadow Texture Render Encoder",
    });

    // Begin render pass that clears to full energy (1.0) and renders shadow polygons
    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.textureView,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 1.0, g: 1.0, b: 1.0, a: 1.0 },
        },
      ],
      label: "Shadow Texture Render Pass",
    });

    renderPass.setPipeline(this.renderPipeline);
    renderPass.setBindGroup(0, this.bindGroup);
    renderPass.setVertexBuffer(0, this.vertexBuffer);
    renderPass.draw(this.vertexCount);
    renderPass.end();

    // Submit
    device.queue.submit([commandEncoder.finish()]);
  }

  /**
   * Build vertex data for all shadow polygons.
   * Each polygon is triangulated using ear clipping (works for concave polygons).
   *
   * Uses the pre-computed polygon.vertices from ShadowGeometry.
   *
   * Returns flat array: [x1, y1, idx1, x2, y2, idx2, ...]
   */
  private buildVertexData(polygons: ShadowPolygonRenderData[]): number[] {
    const vertices: number[] = [];

    for (let polygonIndex = 0; polygonIndex < polygons.length; polygonIndex++) {
      const polygon = polygons[polygonIndex];

      // Use pre-computed vertices from ShadowGeometry
      const polyVerts = polygon.vertices;

      // Triangulate using ear clipping (handles concave polygons)
      const indices = earClipTriangulate(polyVerts);
      if (!indices) {
        console.warn(
          `[ShadowTextureRenderer] Failed to triangulate polygon ${polygonIndex}`,
        );
        continue;
      }

      // Output triangles
      for (let i = 0; i < indices.length; i += 3) {
        const v0 = polyVerts[indices[i]];
        const v1 = polyVerts[indices[i + 1]];
        const v2 = polyVerts[indices[i + 2]];
        // Store polygon index directly (used to index into shadow data buffer)
        vertices.push(v0.x, v0.y, polygonIndex);
        vertices.push(v1.x, v1.y, polygonIndex);
        vertices.push(v2.x, v2.y, polygonIndex);
      }
    }

    return vertices;
  }

  /**
   * Clear the shadow texture to full energy (no shadows).
   */
  private clearTexture(): void {
    if (!this.texture || !this.textureView || !this.renderPipeline) {
      return;
    }

    const device = getWebGPU().device;
    const commandEncoder = device.createCommandEncoder({
      label: "Shadow Texture Clear Encoder",
    });

    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.textureView,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 1.0, g: 1.0, b: 1.0, a: 1.0 },
        },
      ],
      label: "Shadow Texture Clear Pass",
    });
    renderPass.end();

    device.queue.submit([commandEncoder.finish()]);
  }

  /**
   * Get the shadow texture view for binding in other shaders.
   */
  getTextureView(): GPUTextureView | null {
    return this.textureView;
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
   * Check if the renderer is initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Clean up GPU resources.
   */
  destroy(): void {
    this.texture?.destroy();
    this.vertexBuffer?.destroy();
    this.uniformBuffer?.destroy();
    this.texture = null;
    this.textureView = null;
    this.vertexBuffer = null;
    this.uniformBuffer = null;
    this.bindGroup = null;
    this.bindGroupLayout = null;
    this.renderPipeline = null;
    this.initialized = false;
  }
}
