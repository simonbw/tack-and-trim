/**
 * Wavefront Mesh Rasterizer
 *
 * Rasterizes wavefront meshes to a screen-space rgba16float 2D texture array.
 * Each layer corresponds to one wave source. The water height shader samples
 * this texture to get per-wave amplitude, direction offset, and phase correction
 * instead of computing shadow/refraction/terrain-factor per pixel.
 *
 * Fragment output: vec4(phasorCos, phasorSin, 0, turbulence)
 * Clear color: (0, 0, 0, 0) = shadow zone (zero amplitude)
 * Skirt geometry extends the mesh far beyond the domain, so uncovered pixels
 * are always shadow zones behind terrain, never open ocean.
 * RGB channels use additive blending to accumulate phasor contributions.
 * Alpha channel uses max blending to preserve peak breaking intensity.
 */

import { defineUniformStruct, mat3x3 } from "../../core/graphics/UniformStruct";
import type { Matrix3 } from "../../core/graphics/Matrix3";
import { validateShaderModuleCompilation } from "../../core/graphics/webgpu/WebGPUDevice";
import type { GPUProfiler } from "../../core/graphics/webgpu/GPUProfiler";
import type { WavefrontMesh } from "./WavefrontMesh";

const RasterizerUniforms = defineUniformStruct("RasterizerParams", {
  // World → clip for the target texture (screen-aligned, rotation-aware).
  worldToTexClip: mat3x3,
});

const SHADER_CODE = /*wgsl*/ `
struct RasterizerParams {
  worldToTexClip: mat3x3<f32>,
}

@group(0) @binding(0) var<uniform> params: RasterizerParams;

struct VertexInput {
  @location(0) position: vec2<f32>,
  @location(1) amplitudeFactor: f32,
  @location(2) turbulence: f32,
  @location(3) phaseOffset: f32,
  @location(4) blendWeight: f32,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) amplitudeFactor: f32,
  @location(1) turbulence: f32,
  @location(2) phaseOffset: f32,
  @location(3) blendWeight: f32,
}

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
  // World position → texture clip (screen-aligned, rotation-aware)
  let clip = (params.worldToTexClip * vec3<f32>(in.position, 1.0)).xy;

  var out: VertexOutput;
  out.position = vec4<f32>(clip, 0.0, 1.0);
  out.amplitudeFactor = in.amplitudeFactor;
  out.turbulence = in.turbulence;
  out.phaseOffset = in.phaseOffset;
  out.blendWeight = in.blendWeight;
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let pc = in.amplitudeFactor * cos(in.phaseOffset);
  let ps = in.amplitudeFactor * sin(in.phaseOffset);
  return vec4<f32>(pc, ps, 0.0, in.turbulence);
}
`;

/**
 * Rasterizes wavefront meshes to a screen-space texture array.
 */
export class WavefrontRasterizer {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private uniforms = RasterizerUniforms.create();
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private coverageQuadVertexBuffer: GPUBuffer | null = null;
  private coverageQuadIndexBuffer: GPUBuffer | null = null;
  private coverageQuadVertices = new Float32Array(4 * 6);
  private initialized = false;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    const device = this.device;

    const shaderModule = device.createShaderModule({
      code: SHADER_CODE,
      label: "Wavefront Rasterizer Shader",
    });
    await validateShaderModuleCompilation(
      shaderModule,
      SHADER_CODE,
      "Wavefront Rasterizer Shader",
    );

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
              { format: "float32", offset: 12, shaderLocation: 2 }, // turbulence
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
   * @param worldToTexClip - World → texture clip transform (screen-aligned)
   * @param texture - Target rgba16float 2D array texture
   */
  render(
    encoder: GPUCommandEncoder,
    meshes: readonly WavefrontMesh[],
    worldToTexClip: Matrix3,
    texture: GPUTexture,
    gpuProfiler?: GPUProfiler | null,
  ): void {
    if (
      !this.initialized ||
      !this.pipeline ||
      !this.bindGroup ||
      !this.uniformBuffer
    )
      return;

    // Update transform uniform
    this.uniforms.set.worldToTexClip(worldToTexClip);
    this.uniforms.uploadTo(this.uniformBuffer);

    // Find first and last non-empty mesh indices for GPU profiling
    let firstMeshIdx = -1;
    let lastMeshIdx = -1;
    for (let i = 0; i < meshes.length; i++) {
      if (meshes[i].indexCount > 0) {
        if (firstMeshIdx === -1) firstMeshIdx = i;
        lastMeshIdx = i;
      }
    }

    // Render each wave source to its layer
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i];
      if (mesh.indexCount === 0) continue;

      // Attach begin timestamp to first pass, end timestamp to last pass
      let timestampWrites: GPURenderPassTimestampWrites | undefined;
      if (i === firstMeshIdx && i === lastMeshIdx) {
        timestampWrites = gpuProfiler?.getTimestampWrites("surface.rasterize");
      } else if (i === firstMeshIdx) {
        timestampWrites =
          gpuProfiler?.getTimestampWritesBegin("surface.rasterize");
      } else if (i === lastMeshIdx) {
        timestampWrites =
          gpuProfiler?.getTimestampWritesEnd("surface.rasterize");
      }

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
        timestampWrites,
        label: `Wavefront Rasterize Wave ${i}`,
      });

      renderPass.setPipeline(this.pipeline);
      renderPass.setBindGroup(0, this.bindGroup);

      // Draw mesh triangles — additive blending accumulates phasors.
      // Skirt geometry extends beyond the domain, so uncovered pixels (clear
      // color 0,0,0,0) are either shadow zones or unreachable far-field.
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
