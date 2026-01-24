/**
 * Terrain physics tile compute implementation.
 *
 * Uses the TerrainStateShader for tile-based terrain queries with GPU rasterization.
 * Contours are tessellated to triangles and rendered with depth testing for
 * efficient containment detection.
 *
 * Implements DataTileCompute interface for use with DataTileComputePipeline.
 */

import { getWebGPU } from "../../../../core/graphics/webgpu/WebGPUDevice";
import type { DataTileCompute } from "../../datatiles/DataTileComputePipeline";
import { tessellateContour, TessellatedContour } from "../ContourTessellation";
import { TerrainDefinition, buildTerrainGPUData } from "../LandMass";
import { TERRAIN_TILE_RESOLUTION } from "../TerrainConstants";
import { TerrainComputeBuffers } from "./TerrainComputeBuffers";
import { TerrainStateShader } from "./TerrainStateShader";

/**
 * Terrain tile compute using render pass with depth testing.
 * Implements DataTileCompute interface for use with DataTileComputePipeline.
 */
export class TerrainDataTileCompute implements DataTileCompute {
  private shader: TerrainStateShader;
  private buffers: TerrainComputeBuffers;
  private bindGroup: GPUBindGroup | null = null;
  private outputTexture: GPUTexture | null = null;
  private depthTexture: GPUTexture | null = null;

  private vertexBuffer: GPUBuffer | null = null;
  private indexBuffer: GPUBuffer | null = null;
  private vertexCount: number = 0;
  private indexCount: number = 0;

  private textureSize: number;
  private currentDefinition: TerrainDefinition | null = null;

  constructor(
    buffers: TerrainComputeBuffers,
    textureSize: number = TERRAIN_TILE_RESOLUTION,
  ) {
    this.buffers = buffers;
    this.textureSize = textureSize;
    this.shader = new TerrainStateShader();
  }

  /**
   * Initialize WebGPU resources.
   */
  async init(): Promise<void> {
    const device = getWebGPU().device;

    // Initialize render shader
    await this.shader.init();

    // Create output texture (render target)
    // rgba32float - matches water format for consistency
    this.outputTexture = device.createTexture({
      size: { width: this.textureSize, height: this.textureSize },
      format: "rgba32float",
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
      label: "Terrain Tile Output Texture",
    });

    // Create depth texture for contour depth testing
    this.depthTexture = device.createTexture({
      size: { width: this.textureSize, height: this.textureSize },
      format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
      label: "Terrain Tile Depth Texture",
    });

    // Create bind group
    this.bindGroup = this.shader.createBindGroup({
      params: { buffer: this.buffers.paramsBuffer },
      controlPoints: { buffer: this.buffers.controlPointsBuffer },
      contours: { buffer: this.buffers.contourBuffer },
      children: { buffer: this.buffers.childrenBuffer },
    });
  }

  /**
   * Update tessellated geometry when terrain definition changes.
   */
  updateTerrainGeometry(definition: TerrainDefinition): void {
    if (this.currentDefinition === definition) {
      return;
    }
    this.currentDefinition = definition;

    const device = getWebGPU().device;
    const gpuData = buildTerrainGPUData(definition);
    const contours = definition.contours;

    // Tessellate all contours
    const tessellated: TessellatedContour[] = [];
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
      this.vertexCount = 0;
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
      // Copy vertices
      combinedVertices.set(t.vertices, vertexOffset);
      vertexOffset += t.vertices.length;

      // Copy indices (offset by vertex base)
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
      label: "Terrain Vertex Buffer",
    });
    device.queue.writeBuffer(this.vertexBuffer, 0, combinedVertices);

    this.indexBuffer = device.createBuffer({
      size: combinedIndices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      label: "Terrain Index Buffer",
    });
    device.queue.writeBuffer(this.indexBuffer, 0, combinedIndices);

    this.vertexCount = totalVertices;
    this.indexCount = totalIndices;
  }

  /**
   * Run the render pass for a tile viewport.
   */
  runCompute(
    time: number,
    left: number,
    top: number,
    width: number,
    height: number,
  ): void {
    if (!this.bindGroup || !this.outputTexture || !this.depthTexture) {
      return;
    }

    const device = getWebGPU().device;
    const pipeline = this.shader.getPipeline();
    const oceanPipeline = this.shader.getOceanPipeline();

    if (!pipeline || !oceanPipeline) {
      return;
    }

    // Update params buffer
    this.buffers.updateParams({
      time,
      viewportLeft: left,
      viewportTop: top,
      viewportWidth: width,
      viewportHeight: height,
      textureSizeX: this.textureSize,
      textureSizeY: this.textureSize,
      contourCount: this.buffers.getContourCount(),
      defaultDepth: this.buffers.getDefaultDepth(),
      maxDepth: this.buffers.getMaxDepth(),
    });

    // Create command encoder
    const commandEncoder = device.createCommandEncoder({
      label: "Terrain Tile Render Encoder",
    });

    // Begin render pass
    const renderPass = commandEncoder.beginRenderPass({
      label: "Terrain Tile Render Pass",
      colorAttachments: [
        {
          view: this.outputTexture.createView(),
          clearValue: { r: -50, g: 0, b: 0, a: 1 }, // Default depth
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
    });

    // Draw ocean background first (z=1, farthest)
    renderPass.setPipeline(oceanPipeline);
    renderPass.setBindGroup(0, this.bindGroup);
    renderPass.draw(6); // Fullscreen quad

    // Draw contours if we have geometry
    if (this.indexCount > 0 && this.vertexBuffer && this.indexBuffer) {
      renderPass.setPipeline(pipeline);
      renderPass.setBindGroup(0, this.bindGroup);
      renderPass.setVertexBuffer(0, this.vertexBuffer);
      renderPass.setIndexBuffer(this.indexBuffer, "uint32");
      renderPass.drawIndexed(this.indexCount);
    }

    renderPass.end();

    device.queue.submit([commandEncoder.finish()]);
  }

  /**
   * Get the output texture for readback.
   */
  getOutputTexture(): GPUTexture | null {
    return this.outputTexture;
  }

  /**
   * Clean up GPU resources.
   */
  destroy(): void {
    this.outputTexture?.destroy();
    this.depthTexture?.destroy();
    this.vertexBuffer?.destroy();
    this.indexBuffer?.destroy();
    this.shader.destroy();
    this.bindGroup = null;
    this.currentDefinition = null;
    // Don't destroy buffers - they're shared
  }
}
