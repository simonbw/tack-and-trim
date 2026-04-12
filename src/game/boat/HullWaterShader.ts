/**
 * Custom WebGPU render pipeline for bilge water inside the hull.
 *
 * Draws a single flat quad at the interior water level and relies on the
 * boat layer's depth buffer to clip it against deck zones: the cockpit sole
 * (low floorZ) loses to the water, benches/foredeck (higher floorZ) beat
 * the water. No zone awareness needed — the GPU does it per-pixel.
 *
 * Vertex data is baked on the CPU each frame (same pattern as ClothRenderer +
 * SailShader): boat yaw + position applied to produce world-space x/y, and
 * body.worldZ applied to produce world-space z for depth writing.
 *
 * Fragment shader: cheap 2-octave hash noise drifting with time, biased by
 * the current slosh offset so ripples visibly tilt with boat heel. Alpha
 * ramps with the water fill fraction.
 */

import { Matrix3 } from "../../core/graphics/Matrix3";
import {
  defineUniformStruct,
  f32,
  mat3x3,
  vec2,
  vec4,
} from "../../core/graphics/UniformStruct";
import { getWebGPU } from "../../core/graphics/webgpu/WebGPUDevice";
import type { WebGPURenderer } from "../../core/graphics/webgpu/WebGPURenderer";

/** 5 floats per vertex: position (2) + localUV (2) + z (1) */
export const HULL_WATER_VERTEX_SIZE = 5;
const HULL_WATER_VERTEX_STRIDE = HULL_WATER_VERTEX_SIZE * 4; // 20 bytes

const HullWaterUniforms = defineUniformStruct("HullWaterUniforms", {
  viewMatrix: mat3x3,
  baseColor: vec4,
  slosh: vec2,
  time: f32,
  fillFraction: f32,
});

const HULL_WATER_SHADER_SOURCE = /*wgsl*/ `
${HullWaterUniforms.wgsl}

// Depth mapping — must match WebGPURenderer constants
const Z_MIN: f32 = -10.0;
const Z_MAX: f32 = 30.0;

@group(0) @binding(0) var<uniform> uniforms: HullWaterUniforms;

struct VertexInput {
  @location(0) position: vec2<f32>,
  @location(1) localUV: vec2<f32>,
  @location(2) z: f32,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) localUV: vec2<f32>,
}

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
  let worldPos = vec3<f32>(in.position, 1.0);
  let clipPos = uniforms.viewMatrix * worldPos;

  let depth = (in.z - Z_MIN) / (Z_MAX - Z_MIN);

  var out: VertexOutput;
  out.position = vec4<f32>(clipPos.xy, depth, 1.0);
  out.localUV = in.localUV;
  return out;
}

// --- Cheap 2D hash noise (inlined from math.wgsl.ts fn_hash21) ---

fn hash21(p: vec2<f32>) -> f32 {
  var q = fract(p * vec2<f32>(234.34, 435.345));
  q = q + dot(q, q + 34.23);
  return fract(q.x * q.y);
}

// Bilinear value noise over a hash21 grid.
fn valueNoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f); // smoothstep
  let a = hash21(i + vec2<f32>(0.0, 0.0));
  let b = hash21(i + vec2<f32>(1.0, 0.0));
  let c = hash21(i + vec2<f32>(0.0, 1.0));
  let d = hash21(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// --- Fragment shader ---

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let t = uniforms.time;
  let slosh = uniforms.slosh; // (offset, velocity)

  // Two octaves drifting with time. Low octave biased by slosh so the
  // pattern visibly shifts toward the low side when heeled.
  let uv = in.localUV;
  let lowFreq = uv * 0.35 + vec2<f32>(t * 0.15, -t * 0.08)
              + vec2<f32>(slosh.x * 1.2, 0.0);
  let highFreq = uv * 1.1 + vec2<f32>(-t * 0.22, t * 0.17)
              + vec2<f32>(slosh.y * 0.3, 0.0);

  let n = valueNoise(lowFreq) * 0.65 + valueNoise(highFreq) * 0.35;

  // Alpha ramps with fill fraction: barely-there film at low fill,
  // saturated pool near max fill.
  let fill = clamp(uniforms.fillFraction, 0.0, 1.0);
  let baseAlpha = uniforms.baseColor.a * (0.35 + 0.65 * fill);

  // Noise perturbs alpha +/- ~15%, giving a subtle sense of surface motion
  // without obscuring the underlying color.
  let alpha = clamp(baseAlpha * (0.85 + 0.3 * n), 0.0, 1.0);

  // Slightly brighter where noise is high — hint of specular without
  // actually doing lighting.
  let tint = uniforms.baseColor.rgb * (0.9 + 0.2 * n);

  return vec4<f32>(tint, alpha);
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
      HULL_WATER_SHADER_SOURCE,
      "Hull Water Shader",
    );

    bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
      label: "Hull Water Bind Group Layout",
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
      label: "Hull Water Pipeline Layout",
    });

    const vertexBufferLayout: GPUVertexBufferLayout = {
      arrayStride: HULL_WATER_VERTEX_STRIDE,
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x2" }, // position
        { shaderLocation: 1, offset: 8, format: "float32x2" }, // localUV
        { shaderLocation: 2, offset: 16, format: "float32" }, // z
      ],
    };

    const fragmentState: GPUFragmentState = {
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
    };

    const vertexState: GPUVertexState = {
      module: shaderModule,
      entryPoint: "vs_main",
      buffers: [vertexBufferLayout],
    };

    // Same depth mode as the rest of the boat layer (read-write, greater-equal).
    // Writing depth is fine: the only thing that draws after us in this frame
    // is the air displacement cap at deckHeight, which wins anywhere it writes.
    pipelineWithDepth = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: vertexState,
      fragment: fragmentState,
      primitive: { topology: "triangle-list" },
      depthStencil: {
        format: "depth24plus",
        depthCompare: "greater-equal",
        depthWriteEnabled: true,
      },
      label: "Hull Water Pipeline",
    });
  })();

  return initPromise;
}

/**
 * Per-boat GPU resources for the bilge water quad: vertex/index/uniform
 * buffers and bind group. One instance per BoatRenderer.
 */
export class HullWaterShaderInstance {
  private vertexBuffer: GPUBuffer | null = null;
  private indexBuffer: GPUBuffer | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private uniforms = HullWaterUniforms.create();
  private readonly maxVertices: number;
  private readonly maxIndices: number;
  private readonly combinedMatrix = new Matrix3();

  constructor(maxVertices: number, maxIndices: number) {
    this.maxVertices = maxVertices;
    this.maxIndices = maxIndices;
  }

  /** Lazily create GPU buffers. Returns false if the pipeline isn't ready yet. */
  private ensureBuffers(): boolean {
    if (this.vertexBuffer) return true;
    if (!pipelineWithDepth || !bindGroupLayout) return false;

    const device = getWebGPU().device;

    this.vertexBuffer = device.createBuffer({
      size: this.maxVertices * HULL_WATER_VERTEX_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      label: "Hull Water Vertex Buffer",
    });

    // Pad index buffer to a 4-byte multiple (uint16 indices).
    const indexBufferSize = Math.ceil((this.maxIndices * 2) / 4) * 4;
    this.indexBuffer = device.createBuffer({
      size: indexBufferSize,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      label: "Hull Water Index Buffer",
    });

    this.uniformBuffer = device.createBuffer({
      size: HullWaterUniforms.byteSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Hull Water Uniform Buffer",
    });

    this.bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer },
        },
      ],
      label: "Hull Water Bind Group",
    });

    return true;
  }

  /**
   * Upload vertex data and draw the water quad.
   * Caller must call `renderer.flush()` before this so prior batched draws
   * have committed their depth writes.
   */
  draw(
    renderer: WebGPURenderer,
    vertexData: Float32Array,
    vertexCount: number,
    indexData: Uint16Array,
    indexCount: number,
    color: number,
    alpha: number,
    sloshOffset: number,
    sloshVelocity: number,
    fillFraction: number,
    time: number,
  ): void {
    // Kick off async init if not done yet; skip this frame.
    if (!pipelineWithDepth) {
      ensureInitialized();
      return;
    }

    if (!this.ensureBuffers()) return;

    const device = getWebGPU().device;
    const renderPass = renderer.getCurrentRenderPass();
    if (!renderPass) return;

    // Upload vertex data
    const vData = vertexData.subarray(0, vertexCount * HULL_WATER_VERTEX_SIZE);
    device.queue.writeBuffer(
      this.vertexBuffer!,
      0,
      vData.buffer,
      vData.byteOffset,
      vData.byteLength,
    );

    // Upload index data (caller pre-pads indexData to an even length so its
    // byte length is a 4-byte multiple).
    device.queue.writeBuffer(
      this.indexBuffer!,
      0,
      indexData.buffer,
      indexData.byteOffset,
      indexData.byteLength,
    );

    // Uniforms — same viewMatrix prep as SailShader: combine world→screen
    // (camera) with screen→clip (view).
    const baseR = ((color >> 16) & 0xff) / 255;
    const baseG = ((color >> 8) & 0xff) / 255;
    const baseB = (color & 0xff) / 255;
    this.combinedMatrix.copyFrom(renderer.getViewMatrix());
    this.combinedMatrix.multiply(renderer.getTransform());
    this.uniforms.set.viewMatrix(this.combinedMatrix);
    this.uniforms.set.baseColor([baseR, baseG, baseB, alpha]);
    this.uniforms.set.slosh([sloshOffset, sloshVelocity]);
    this.uniforms.set.time(time);
    this.uniforms.set.fillFraction(fillFraction);
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
