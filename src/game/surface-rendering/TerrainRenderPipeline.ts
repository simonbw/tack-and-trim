/**
 * Terrain rendering pipeline.
 *
 * Renders terrain height texture for the visible viewport using GPU rasterization.
 * Contours are tessellated to triangles and rendered with depth testing for
 * efficient containment detection.
 * Output is passed to SurfaceShader for depth-based rendering.
 */

import {
  GPUProfiler,
  GPUProfileSection,
} from "../../core/graphics/webgpu/GPUProfiler";
import { getWebGPU } from "../../core/graphics/webgpu/WebGPUDevice";
import { profile } from "../../core/util/Profiler";
import { tessellateContour } from "../world-data/terrain/ContourTessellation";
import {
  TerrainContour,
  TerrainDefinition,
  buildTerrainGPUData,
} from "../world-data/terrain/LandMass";
import { TerrainComputeBuffers } from "../world-data/terrain/webgpu/TerrainComputeBuffers";
import { TerrainStateShader } from "../world-data/terrain/webgpu/TerrainStateShader";

/**
 * Viewport bounds for terrain computation.
 */
export interface TerrainViewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Terrain rendering pipeline using GPU rasterization.
 */
export class TerrainRenderPipeline {
  private shader: TerrainStateShader | null = null;
  private buffers: TerrainComputeBuffers | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private outputTexture: GPUTexture | null = null;
  private depthTexture: GPUTexture | null = null;
  private outputTextureView: GPUTextureView | null = null;
  private initialized = false;

  private vertexBuffer: GPUBuffer | null = null;
  private indexBuffer: GPUBuffer | null = null;
  private indexCount: number = 0;
  private currentDefinition: TerrainDefinition | null = null;

  private textureWidth: number;
  private textureHeight: number;

  constructor(textureWidth: number, textureHeight: number) {
    this.textureWidth = textureWidth;
    this.textureHeight = textureHeight;
  }

  /**
   * Initialize WebGPU resources.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    const device = getWebGPU().device;

    // Initialize render shader
    this.shader = new TerrainStateShader();
    await this.shader.init();

    // Create shared buffers
    this.buffers = new TerrainComputeBuffers();

    // Create output texture (render target)
    this.outputTexture = device.createTexture({
      size: { width: this.textureWidth, height: this.textureHeight },
      format: "rgba32float",
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
      label: "Terrain Render Output Texture",
    });
    this.outputTextureView = this.outputTexture.createView();

    // Create depth texture
    this.depthTexture = device.createTexture({
      size: { width: this.textureWidth, height: this.textureHeight },
      format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
      label: "Terrain Render Depth Texture",
    });

    // Create bind group
    this.bindGroup = this.shader.createBindGroup({
      params: { buffer: this.buffers.paramsBuffer },
      controlPoints: { buffer: this.buffers.controlPointsBuffer },
      contours: { buffer: this.buffers.contourBuffer },
      children: { buffer: this.buffers.childrenBuffer },
    });

    this.initialized = true;
  }

  /**
   * Update terrain definition (contours).
   */
  setTerrainDefinition(definition: TerrainDefinition): void {
    this.buffers?.updateTerrainData(definition);
    this.updateTerrainGeometry(definition);
  }

  /**
   * Update tessellated geometry when terrain definition changes.
   */
  private updateTerrainGeometry(definition: TerrainDefinition): void {
    if (this.currentDefinition === definition || !this.buffers) {
      return;
    }
    this.currentDefinition = definition;

    const device = getWebGPU().device;
    const gpuData = buildTerrainGPUData(definition);
    const contours = definition.contours;

    // Tessellate all contours
    const tessellated: {
      vertices: Float32Array;
      indices: Uint32Array;
      vertexCount: number;
      indexCount: number;
    }[] = [];
    let pointStart = 0;

    for (let i = 0; i < contours.length; i++) {
      const contour = contours[i];
      const tess = tessellateContour(
        gpuData.controlPointsData,
        pointStart,
        contour.controlPoints.length,
        i,
      );
      tessellated.push(tess);
      pointStart += contour.controlPoints.length;
    }

    // Combine all tessellated data
    let totalVertices = 0;
    let totalIndices = 0;
    for (const t of tessellated) {
      totalVertices += t.vertexCount;
      totalIndices += t.indexCount;
    }

    if (totalVertices === 0) {
      this.indexCount = 0;
      return;
    }

    // Create combined buffers
    const combinedVertices = new Float32Array(totalVertices * 3);
    const combinedIndices = new Uint32Array(totalIndices);

    let vertexOffset = 0;
    let indexOffset = 0;
    let vertexIndexOffset = 0;

    for (const t of tessellated) {
      combinedVertices.set(t.vertices, vertexOffset);
      vertexOffset += t.vertices.length;

      for (let i = 0; i < t.indexCount; i++) {
        combinedIndices[indexOffset + i] = t.indices[i] + vertexIndexOffset;
      }
      indexOffset += t.indexCount;
      vertexIndexOffset += t.vertexCount;
    }

    // Destroy old buffers
    this.vertexBuffer?.destroy();
    this.indexBuffer?.destroy();

    // Create new GPU buffers
    this.vertexBuffer = device.createBuffer({
      size: combinedVertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      label: "Terrain Render Vertex Buffer",
    });
    device.queue.writeBuffer(this.vertexBuffer, 0, combinedVertices);

    this.indexBuffer = device.createBuffer({
      size: combinedIndices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      label: "Terrain Render Index Buffer",
    });
    device.queue.writeBuffer(this.indexBuffer, 0, combinedIndices);

    this.indexCount = totalIndices;
  }

  /**
   * Add a contour to the terrain.
   * Not supported - use setTerrainDefinition instead.
   */
  addContour(_contour: TerrainContour): void {
    throw new Error(
      "TerrainRenderPipeline.addContour is not supported. Use setTerrainDefinition instead.",
    );
  }

  /**
   * Update terrain texture with current state for the given viewport.
   * Runs every frame to keep terrain aligned with camera.
   */
  @profile
  update(
    viewport: TerrainViewport,
    time: number,
    gpuProfiler?: GPUProfiler | null,
    section: GPUProfileSection = "terrainCompute",
  ): void {
    if (
      !this.initialized ||
      !this.shader ||
      !this.buffers ||
      !this.bindGroup ||
      !this.outputTexture ||
      !this.depthTexture
    ) {
      return;
    }

    const device = getWebGPU().device;
    const pipeline = this.shader.getPipeline();
    const oceanPipeline = this.shader.getOceanPipeline();

    if (!pipeline || !oceanPipeline) {
      return;
    }

    // Update params buffer with current viewport
    this.buffers.updateParams({
      time,
      viewportLeft: viewport.left,
      viewportTop: viewport.top,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      textureSizeX: this.textureWidth,
      textureSizeY: this.textureHeight,
      contourCount: this.buffers.getContourCount(),
      defaultDepth: this.buffers.getDefaultDepth(),
      maxDepth: this.buffers.getMaxDepth(),
    });

    // Create command encoder
    const commandEncoder = device.createCommandEncoder({
      label: "Terrain Render Encoder",
    });

    // Begin render pass
    const renderPass = commandEncoder.beginRenderPass({
      label: "Terrain Render Pass",
      colorAttachments: [
        {
          view: this.outputTexture.createView(),
          clearValue: { r: this.buffers.getDefaultDepth(), g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
      timestampWrites: gpuProfiler?.getTimestampWrites(section),
    });

    // Draw ocean background first (z=1, farthest)
    renderPass.setPipeline(oceanPipeline);
    renderPass.setBindGroup(0, this.bindGroup);
    renderPass.draw(6);

    // Draw contours if we have geometry
    if (this.indexCount > 0 && this.vertexBuffer && this.indexBuffer) {
      renderPass.setPipeline(pipeline);
      renderPass.setBindGroup(0, this.bindGroup);
      renderPass.setVertexBuffer(0, this.vertexBuffer);
      renderPass.setIndexBuffer(this.indexBuffer, "uint32");
      renderPass.drawIndexed(this.indexCount);
    }

    renderPass.end();

    // Submit
    device.queue.submit([commandEncoder.finish()]);
  }

  /**
   * Get the output texture view for rendering.
   */
  getOutputTextureView(): GPUTextureView | null {
    return this.outputTextureView;
  }

  /**
   * Get the output texture for readback operations.
   */
  getOutputTexture(): GPUTexture | null {
    return this.outputTexture;
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
   * Check if terrain data has been loaded.
   */
  hasTerrainData(): boolean {
    return (this.buffers?.getContourCount() ?? 0) > 0;
  }

  /**
   * Clean up GPU resources.
   */
  destroy(): void {
    this.buffers?.destroy();
    this.outputTexture?.destroy();
    this.depthTexture?.destroy();
    this.vertexBuffer?.destroy();
    this.indexBuffer?.destroy();
    this.shader?.destroy();
    this.bindGroup = null;
    this.outputTextureView = null;
    this.buffers = null;
    this.shader = null;
    this.currentDefinition = null;
    this.initialized = false;
  }
}
