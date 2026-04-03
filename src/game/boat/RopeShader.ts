/**
 * Custom WebGPU render pipeline for procedural rope rendering.
 *
 * Generates a three-strand twisted rope appearance from per-vertex UVs:
 *   u = cross-rope [-1, +1]
 *   v = cumulative distance along the centerline (feet)
 *
 * The fragment shader produces helical twist stripes, cylindrical
 * cross-section shading, and strand color variation — all procedural,
 * no texture needed.
 *
 * Follows the SailShader pattern: module-level singleton pipeline,
 * per-rope instance with its own GPU buffers.
 */

import { Matrix3 } from "../../core/graphics/Matrix3";
import {
  defineUniformStruct,
  f32,
  mat3x3,
  vec4,
} from "../../core/graphics/UniformStruct";
import { getWebGPU } from "../../core/graphics/webgpu/WebGPUDevice";
import type { WebGPURenderer } from "../../core/graphics/webgpu/WebGPURenderer";
import { ROPE_VERTEX_FLOATS } from "./tessellation";

/** 5 floats per vertex: position (2) + uv (2) + z (1) */
const ROPE_VERTEX_STRIDE = ROPE_VERTEX_FLOATS * 4; // 20 bytes

const RopeUniforms = defineUniformStruct("RopeUniforms", {
  viewMatrix: mat3x3,
  colorA: vec4,
  colorB: vec4,
  twistFrequency: f32,
  time: f32,
});

const ROPE_SHADER_SOURCE = /*wgsl*/ `
${RopeUniforms.wgsl}

// Depth mapping — must match WebGPURenderer constants
const Z_MIN: f32 = -10.0;
const Z_MAX: f32 = 30.0;
const PI: f32 = 3.14159265;

@group(0) @binding(0) var<uniform> uniforms: RopeUniforms;

struct VertexInput {
  @location(0) position: vec2<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) z: f32,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
  let worldPos = vec3<f32>(in.position, 1.0);
  let clipPos = uniforms.viewMatrix * worldPos;
  let depth = (in.z - Z_MIN) / (Z_MAX - Z_MIN);

  var out: VertexOutput;
  out.position = vec4<f32>(clipPos.xy, depth, 1.0);
  out.uv = in.uv;
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let u = in.uv.x;  // -1 to +1, cross-rope
  let v = in.uv.y;  // cumulative distance (feet)

  // Helical stripe pattern — sin(v * freq + u * PI) creates diagonal stripes
  // that simulate twisted strands wrapping around the rope
  let phase = v * uniforms.twistFrequency + u * PI;
  let strand = sin(phase);

  // Two-color blend: strand > 0 = color A, strand < 0 = color B
  let t = smoothstep(-0.15, 0.15, strand);
  let finalColor = mix(uniforms.colorB.rgb, uniforms.colorA.rgb, t);
  let alpha = mix(uniforms.colorB.a, uniforms.colorA.a, t);

  return vec4<f32>(finalColor, alpha);
}
`;

// Module-level singleton state
let pipelineWithDepth: GPURenderPipeline | null = null;
let bindGroupLayout: GPUBindGroupLayout | null = null;
let initPromise: Promise<void> | null = null;

async function ensureInitialized(): Promise<void> {
  if (pipelineWithDepth) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const gpu = getWebGPU();
    const device = gpu.device;

    const shaderModule = await gpu.createShaderModuleChecked(
      ROPE_SHADER_SOURCE,
      "Rope Shader",
    );

    bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
      label: "Rope Bind Group Layout",
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
      label: "Rope Pipeline Layout",
    });

    const vertexBufferLayout: GPUVertexBufferLayout = {
      arrayStride: ROPE_VERTEX_STRIDE,
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x2" }, // position
        { shaderLocation: 1, offset: 8, format: "float32x2" }, // uv
        { shaderLocation: 2, offset: 16, format: "float32" }, // z
      ],
    };

    pipelineWithDepth = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
        buffers: [vertexBufferLayout],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [
          {
            format: gpu.preferredFormat,
            blend: {
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: {
        format: "depth24plus",
        depthCompare: "greater-equal",
        depthWriteEnabled: true,
      },
      label: "Rope Pipeline",
    });
  })();

  return initPromise;
}

/**
 * Per-rope GPU resources: vertex/index/uniform buffers and bind group.
 * Each rendered rope (sheet, rode) creates one of these.
 */
export class RopeShaderInstance {
  private vertexBuffer: GPUBuffer | null = null;
  private indexBuffer: GPUBuffer | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private uniforms = RopeUniforms.create();
  private readonly maxVertices: number;
  private readonly maxIndices: number;
  private readonly combinedMatrix = new Matrix3();

  /** Pre-allocated tessellation output buffers. */
  readonly scratchVertexData: Float32Array;
  readonly scratchIndexData: Uint16Array;

  constructor(maxPoints: number) {
    this.maxVertices = maxPoints * 2;
    this.maxIndices = (maxPoints - 1) * 6;
    this.scratchVertexData = new Float32Array(
      this.maxVertices * ROPE_VERTEX_FLOATS,
    );
    // Pad to even length for 4-byte alignment
    this.scratchIndexData = new Uint16Array((this.maxIndices + 1) & ~1);
  }

  /** Lazily create GPU buffers. Returns false if not ready yet. */
  private ensureBuffers(): boolean {
    if (this.vertexBuffer) return true;
    if (!pipelineWithDepth || !bindGroupLayout) return false;

    const device = getWebGPU().device;

    this.vertexBuffer = device.createBuffer({
      size: this.maxVertices * ROPE_VERTEX_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      label: "Rope Vertex Buffer",
    });

    this.indexBuffer = device.createBuffer({
      size: this.scratchIndexData.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      label: "Rope Index Buffer",
    });

    this.uniformBuffer = device.createBuffer({
      size: RopeUniforms.byteSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Rope Uniform Buffer",
    });

    this.bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
      label: "Rope Bind Group",
    });

    return true;
  }

  /**
   * Upload vertex data and draw with the rope shader pipeline.
   * Caller must have called renderer.flush() before this.
   */
  draw(
    renderer: WebGPURenderer,
    vertexData: Float32Array,
    vertexCount: number,
    indexData: Uint16Array,
    indexCount: number,
    colorA: number,
    colorB: number,
    alpha: number,
    ropeWidth: number,
    time: number,
  ): void {
    if (!pipelineWithDepth) {
      ensureInitialized();
      return;
    }

    if (!this.ensureBuffers()) return;
    if (vertexCount === 0 || indexCount === 0) return;

    const device = getWebGPU().device;
    const renderPass = renderer.getCurrentRenderPass();
    if (!renderPass) return;

    // Upload vertex data
    const vBytes = vertexCount * ROPE_VERTEX_STRIDE;
    device.queue.writeBuffer(
      this.vertexBuffer!,
      0,
      vertexData.buffer,
      vertexData.byteOffset,
      vBytes,
    );

    // Upload index data
    const iBytes = Math.ceil((indexCount * 2) / 4) * 4; // 4-byte aligned
    device.queue.writeBuffer(
      this.indexBuffer!,
      0,
      indexData.buffer,
      indexData.byteOffset,
      iBytes,
    );

    // Upload uniforms
    const rA = ((colorA >> 16) & 0xff) / 255;
    const gA = ((colorA >> 8) & 0xff) / 255;
    const bA = (colorA & 0xff) / 255;
    const rB = ((colorB >> 16) & 0xff) / 255;
    const gB = ((colorB >> 8) & 0xff) / 255;
    const bB = (colorB & 0xff) / 255;

    this.combinedMatrix.copyFrom(renderer.getViewMatrix());
    this.combinedMatrix.multiply(renderer.getTransform());
    this.uniforms.set.viewMatrix(this.combinedMatrix);
    this.uniforms.set.colorA([rA, gA, bA, alpha]);
    this.uniforms.set.colorB([rB, gB, bB, alpha]);
    // One full twist every 8 rope diameters
    this.uniforms.set.twistFrequency(
      (2 * Math.PI) / (8 * Math.max(ropeWidth, 0.01)),
    );
    this.uniforms.set.time(time);
    this.uniforms.uploadTo(this.uniformBuffer!);

    // Draw
    renderPass.setPipeline(pipelineWithDepth!);
    renderPass.setBindGroup(0, this.bindGroup!);
    renderPass.setVertexBuffer(0, this.vertexBuffer!);
    renderPass.setIndexBuffer(this.indexBuffer!, "uint16");
    renderPass.drawIndexed(indexCount);
  }

  /** Clean up GPU resources. */
  destroy(): void {
    this.vertexBuffer?.destroy();
    this.indexBuffer?.destroy();
    this.uniformBuffer?.destroy();
    this.vertexBuffer = null;
    this.indexBuffer = null;
    this.uniformBuffer = null;
    this.bindGroup = null;
  }
}
