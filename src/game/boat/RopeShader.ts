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
  u32,
  vec4,
} from "../../core/graphics/UniformStruct";
import { getWebGPU } from "../../core/graphics/webgpu/WebGPUDevice";
import type { WebGPURenderer } from "../../core/graphics/webgpu/WebGPURenderer";
import { ROPE_VERTEX_FLOATS } from "./tessellation";

/** 5 floats per vertex: position (2) + uv (2) + z (1) */
const ROPE_VERTEX_STRIDE = ROPE_VERTEX_FLOATS * 4; // 20 bytes

/** Number of carrier slots in the braid pattern. */
export const BRAID_CARRIER_COUNT = 8;

const RopeUniforms = defineUniformStruct("RopeUniforms", {
  viewMatrix: mat3x3,
  colorA: vec4,
  colorB: vec4,
  twistFrequency: f32,
  time: f32,
  patternType: u32,
  // Braid carrier colors — packed 0xRRGGBB, one per carrier slot.
  carrier0: u32,
  carrier1: u32,
  carrier2: u32,
  carrier3: u32,
  carrier4: u32,
  carrier5: u32,
  carrier6: u32,
  carrier7: u32,
});

/** Pattern type constants — must match WGSL switch cases. */
export const ROPE_PATTERN_TWIST = 0;
export const ROPE_PATTERN_BRAID = 1;

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

// --- Pattern: three-strand twisted rope ---

fn twistedStrand(u: f32, v: f32) -> vec4<f32> {
  let phase = v * uniforms.twistFrequency + u * PI;
  let strand = sin(phase);
  let t = smoothstep(-0.15, 0.15, strand);
  let finalColor = mix(uniforms.colorB.rgb, uniforms.colorA.rgb, t);
  let alpha = mix(uniforms.colorB.a, uniforms.colorA.a, t);
  return vec4<f32>(finalColor, alpha);
}

// --- Pattern: double-braid with diamond weave ---
// Models a 16-plait braided cover as a 45°-rotated grid of diamond cells.
// Each diamond is one strand crossing. Two carrier families (S-laid and Z-laid)
// alternate over/under in a checkerboard. Each carrier slot has its own color,
// passed as packed 0xRRGGBB uniforms.

fn unpackRGB(packed: u32) -> vec3<f32> {
  return vec3<f32>(
    f32((packed >> 16u) & 0xFFu) / 255.0,
    f32((packed >> 8u) & 0xFFu) / 255.0,
    f32(packed & 0xFFu) / 255.0
  );
}

fn getCarrierColor(id: u32) -> vec3<f32> {
  switch id {
    case 0u: { return unpackRGB(uniforms.carrier0); }
    case 1u: { return unpackRGB(uniforms.carrier1); }
    case 2u: { return unpackRGB(uniforms.carrier2); }
    case 3u: { return unpackRGB(uniforms.carrier3); }
    case 4u: { return unpackRGB(uniforms.carrier4); }
    case 5u: { return unpackRGB(uniforms.carrier5); }
    case 6u: { return unpackRGB(uniforms.carrier6); }
    case 7u: { return unpackRGB(uniforms.carrier7); }
    default: { return unpackRGB(uniforms.carrier0); }
  }
}

fn braidedCover(u: f32, v: f32) -> vec4<f32> {
  // Diamonds visible across rope width (half of 16-plait visible from one side)
  let N = 4.0;

  // Recover physical rope width from twist frequency to get square diamonds.
  // twistFrequency = 2π / (8 * ropeWidth)
  let ropeWidth = 2.0 * PI / (8.0 * uniforms.twistFrequency);

  // Scale UV so one diamond = one unit in each axis
  let su = u * N * 0.5;           // u ∈ [-1,+1] → [-N/2, +N/2]
  let sv = v * N / ropeWidth;     // v in feet → diamond count

  // Rotate 45° to create the diamond grid
  let du = su + sv;
  let dv = -su + sv;

  // Integer cell ID
  let ci = floor(du);
  let cj = floor(dv);

  // Over/under checkerboard — determines which carrier family is visible
  let checker = ((ci + cj) % 2.0 + 2.0) % 2.0;
  let isOver = checker < 0.5;

  // Carrier identification along diagonals
  let period = 8.0;
  let sId = ((ci % period) + period) % period;
  let zId = ((cj % period) + period) % period;
  let carrierId = u32(select(zId, sId, isOver));

  let color = getCarrierColor(carrierId);
  return vec4<f32>(color, uniforms.colorA.a);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let u = in.uv.x;
  let v = in.uv.y;

  if (uniforms.patternType == 1u) {
    return braidedCover(u, v);
  }
  return twistedStrand(u, v);
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
    patternType: number,
    braidColors: readonly number[] | null,
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
    this.uniforms.set.patternType(patternType);

    // Upload braid carrier colors (packed 0xRRGGBB)
    if (braidColors) {
      this.uniforms.set.carrier0(braidColors[0] ?? 0);
      this.uniforms.set.carrier1(braidColors[1] ?? 0);
      this.uniforms.set.carrier2(braidColors[2] ?? 0);
      this.uniforms.set.carrier3(braidColors[3] ?? 0);
      this.uniforms.set.carrier4(braidColors[4] ?? 0);
      this.uniforms.set.carrier5(braidColors[5] ?? 0);
      this.uniforms.set.carrier6(braidColors[6] ?? 0);
      this.uniforms.set.carrier7(braidColors[7] ?? 0);
    }

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
