/**
 * Wavefront Mesh Rasterizer
 *
 * Rasterizes wavefront meshes to a screen-space rgba16float 2D texture array.
 * Each layer corresponds to one wave source. The water height shader samples
 * this texture to get per-wave amplitude, direction offset, and phase correction
 * instead of computing shadow/refraction/terrain-factor per pixel.
 *
 * Fragment output: vec4(phasorCos, phasorSin, coverage, breakingIntensity)
 * Clear color: (0, 0, 0, 0) = zero phasors (no mesh coverage)
 * Additive blending accumulates phasor contributions from overlapping triangles.
 * Alpha channel uses max blending to preserve peak breaking intensity.
 */

import { defineUniformStruct, f32 } from "../../core/graphics/UniformStruct";
import { getWebGPU } from "../../core/graphics/webgpu/WebGPUDevice";
import type { Viewport } from "./WavePhysicsResources";
import type { WavefrontMesh } from "./WavefrontMesh";

const RasterizerUniforms = defineUniformStruct("RasterizerParams", {
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
});

const SHADER_CODE = /*wgsl*/ `
struct RasterizerParams {
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
}

@group(0) @binding(0) var<uniform> params: RasterizerParams;

struct VertexInput {
  @location(0) position: vec2<f32>,
  @location(1) amplitudeFactor: f32,
  @location(2) breakingIntensity: f32,
  @location(3) phaseOffset: f32,
  @location(4) blendWeight: f32,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) amplitudeFactor: f32,
  @location(1) breakingIntensity: f32,
  @location(2) phaseOffset: f32,
  @location(3) blendWeight: f32,
}

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
  // World position → NDC using viewport uniforms
  let ndcX = 2.0 * (in.position.x - params.viewportLeft) / params.viewportWidth - 1.0;
  let ndcY = 1.0 - 2.0 * (in.position.y - params.viewportTop) / params.viewportHeight;

  var out: VertexOutput;
  out.position = vec4<f32>(ndcX, ndcY, 0.0, 1.0);
  out.amplitudeFactor = in.amplitudeFactor;
  out.breakingIntensity = in.breakingIntensity;
  out.phaseOffset = in.phaseOffset;
  out.blendWeight = in.blendWeight;
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let w = in.blendWeight;
  let pc = in.amplitudeFactor * cos(in.phaseOffset) * w;
  let ps = in.amplitudeFactor * sin(in.phaseOffset) * w;
  return vec4<f32>(pc, ps, 1.0, in.breakingIntensity * w);
}
`;

/**
 * Rasterizes wavefront meshes to a screen-space texture array.
 */
export class WavefrontRasterizer {
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private uniforms = RasterizerUniforms.create();
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private coverageQuadVertexBuffer: GPUBuffer | null = null;
  private coverageQuadIndexBuffer: GPUBuffer | null = null;
  private coverageQuadVertices = new Float32Array(4 * 6);
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;

    const device = getWebGPU().device;

    const shaderModule = device.createShaderModule({
      code: SHADER_CODE,
      label: "Wavefront Rasterizer Shader",
    });

    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "uniform" },
        },
      ],
      label: "Wavefront Rasterizer Bind Group Layout",
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
      label: "Wavefront Rasterizer Pipeline Layout",
    });

    this.pipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
        buffers: [
          {
            arrayStride: 24, // 6 floats x 4 bytes
            attributes: [
              { format: "float32x2", offset: 0, shaderLocation: 0 }, // position
              { format: "float32", offset: 8, shaderLocation: 1 }, // amplitudeFactor
              { format: "float32", offset: 12, shaderLocation: 2 }, // breakingIntensity
              { format: "float32", offset: 16, shaderLocation: 3 }, // phaseOffset
              { format: "float32", offset: 20, shaderLocation: 4 }, // blendWeight
            ],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [
          {
            format: "rgba16float",
            blend: {
              color: {
                srcFactor: "one",
                dstFactor: "one",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one",
                operation: "max",
              },
            },
          },
        ],
      },
      primitive: {
        topology: "triangle-list",
      },
      label: "Wavefront Rasterizer Pipeline",
    });

    this.uniformBuffer = device.createBuffer({
      size: RasterizerUniforms.byteSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Wavefront Rasterizer Uniforms",
    });

    this.bindGroup = device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer },
        },
      ],
      label: "Wavefront Rasterizer Bind Group",
    });

    // Coverage quad buffers for shadow zone marking
    this.coverageQuadVertexBuffer = device.createBuffer({
      size: 4 * 6 * 4, // 4 vertices × 6 floats × 4 bytes
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      label: "Coverage Quad Vertex Buffer",
    });
    const quadIndices = new Uint32Array([0, 1, 2, 0, 2, 3]);
    this.coverageQuadIndexBuffer = device.createBuffer({
      size: quadIndices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      label: "Coverage Quad Index Buffer",
    });
    device.queue.writeBuffer(this.coverageQuadIndexBuffer, 0, quadIndices);

    this.initialized = true;
  }

  /**
   * Render wavefront meshes to the wave field texture array.
   * One render pass per wave source, targeting that source's layer.
   *
   * @param encoder - Command encoder to record into
   * @param meshes - One mesh per wave source
   * @param viewport - World-space viewport (same as water height shader)
   * @param texture - Target rgba16float 2D array texture
   */
  render(
    encoder: GPUCommandEncoder,
    meshes: readonly WavefrontMesh[],
    viewport: Viewport,
    texture: GPUTexture,
  ): void {
    if (
      !this.initialized ||
      !this.pipeline ||
      !this.bindGroup ||
      !this.uniformBuffer
    )
      return;

    // Update viewport uniforms
    this.uniforms.set.viewportLeft(viewport.left);
    this.uniforms.set.viewportTop(viewport.top);
    this.uniforms.set.viewportWidth(viewport.width);
    this.uniforms.set.viewportHeight(viewport.height);
    this.uniforms.uploadTo(this.uniformBuffer);

    // Render each wave source to its layer
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i];
      if (mesh.indexCount === 0) continue;

      const layerView = texture.createView({
        dimension: "2d",
        baseArrayLayer: i,
        arrayLayerCount: 1,
        label: `Wave Field Layer ${i}`,
      });

      const renderPass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: layerView,
            clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 }, // open ocean defaults
            loadOp: "clear",
            storeOp: "store",
          },
        ],
        label: `Wavefront Rasterize Wave ${i}`,
      });

      renderPass.setPipeline(this.pipeline);
      renderPass.setBindGroup(0, this.bindGroup);

      // Draw coverage quad first: fills bounding area with zero-phasor, coverage=1.
      // Areas inside the bounds but without mesh triangles become shadow zones.
      // Areas outside the bounds remain at coverage=0 (open ocean).
      // Uses the oriented bounding box (not AABB) to match the wave-aligned mesh bounds.
      if (
        mesh.coverageQuad &&
        this.coverageQuadVertexBuffer &&
        this.coverageQuadIndexBuffer
      ) {
        const q = mesh.coverageQuad;
        const v = this.coverageQuadVertices;
        // 4 vertices × 6 floats: [posX, posY, ampFactor, breakingIntensity, phaseOffset, blendWeight]
        // ampFactor=0 → phasors (0,0), coverage=1 from fragment shader
        v[0] = q.x0;
        v[1] = q.y0;
        v[2] = 0;
        v[3] = 0;
        v[4] = 0;
        v[5] = 0;
        v[6] = q.x1;
        v[7] = q.y1;
        v[8] = 0;
        v[9] = 0;
        v[10] = 0;
        v[11] = 0;
        v[12] = q.x2;
        v[13] = q.y2;
        v[14] = 0;
        v[15] = 0;
        v[16] = 0;
        v[17] = 0;
        v[18] = q.x3;
        v[19] = q.y3;
        v[20] = 0;
        v[21] = 0;
        v[22] = 0;
        v[23] = 0;
        getWebGPU().device.queue.writeBuffer(
          this.coverageQuadVertexBuffer,
          0,
          v,
        );
        renderPass.setVertexBuffer(0, this.coverageQuadVertexBuffer);
        renderPass.setIndexBuffer(this.coverageQuadIndexBuffer, "uint32");
        renderPass.drawIndexed(6);
      }

      // Draw mesh triangles on top — additive blending accumulates phasors
      renderPass.setVertexBuffer(0, mesh.vertexBuffer);
      renderPass.setIndexBuffer(mesh.indexBuffer, "uint32");
      renderPass.drawIndexed(mesh.indexCount);
      renderPass.end();
    }

    // Clear remaining layers that don't have meshes
    const totalLayers = texture.depthOrArrayLayers;
    for (let i = meshes.length; i < totalLayers; i++) {
      const layerView = texture.createView({
        dimension: "2d",
        baseArrayLayer: i,
        arrayLayerCount: 1,
        label: `Wave Field Layer ${i} (empty)`,
      });

      const renderPass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: layerView,
            clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
        label: `Wavefront Clear Layer ${i}`,
      });
      renderPass.end();
    }
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
    this.coverageQuadVertexBuffer?.destroy();
    this.coverageQuadIndexBuffer?.destroy();
    this.uniformBuffer = null;
    this.coverageQuadVertexBuffer = null;
    this.coverageQuadIndexBuffer = null;
    this.pipeline = null;
    this.bindGroup = null;
    this.bindGroupLayout = null;
    this.initialized = false;
  }
}
