/**
 * Custom WebGPU render pipeline for cel-shaded sail triangles.
 *
 * Takes projected 2D positions + 3D normals per vertex, computes
 * per-fragment lighting from the sun direction, and quantizes into
 * 2-3 discrete tones for a stylized look.
 *
 * Initialized lazily on first use. Pipeline and GPU buffers are
 * shared across all sails (one pipeline, separate draw calls).
 */

import { Matrix3 } from "../../../core/graphics/Matrix3";
import {
  defineUniformStruct,
  f32,
  mat3x3,
  vec4,
} from "../../../core/graphics/UniformStruct";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import type { WebGPURenderer } from "../../../core/graphics/webgpu/WebGPURenderer";

/** 5 floats per vertex: position (2) + normal (3) */
export const SAIL_VERTEX_SIZE = 5;
const SAIL_VERTEX_STRIDE = SAIL_VERTEX_SIZE * 4; // 20 bytes

const SailUniforms = defineUniformStruct("SailUniforms", {
  viewMatrix: mat3x3,
  baseColor: vec4,
  time: f32,
});

// Inline the scene-lighting functions from scene-lighting.wgsl.ts
// so we don't need the ShaderModule composition system for this one-off pipeline.
const SAIL_SHADER_SOURCE = /*wgsl*/ `
${SailUniforms.wgsl}

// Depth mapping — must match WebGPURenderer constants
const Z_MIN: f32 = -10.0;
const Z_MAX: f32 = 30.0;
// Sails are well above sea level. Use a constant z-height for depth.
const SAIL_Z: f32 = 5.0;

@group(0) @binding(0) var<uniform> uniforms: SailUniforms;

struct VertexInput {
  @location(0) position: vec2<f32>,
  @location(1) normal: vec3<f32>,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) normal: vec3<f32>,
}

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
  let worldPos = vec3<f32>(in.position, 1.0);
  let clipPos = uniforms.viewMatrix * worldPos;

  let depth = (SAIL_Z - Z_MIN) / (Z_MAX - Z_MIN);

  var out: VertexOutput;
  out.position = vec4<f32>(clipPos.xy, depth, 1.0);
  out.normal = in.normal;
  return out;
}

// --- Scene lighting (inlined from scene-lighting.wgsl.ts) ---

const SECONDS_PER_HOUR: f32 = 3600.0;

fn getSunDirection(time: f32) -> vec3<f32> {
  let hour = time / SECONDS_PER_HOUR;
  let sunPhase = (hour - 6.0) * 3.14159 / 12.0;
  let elevation = max(sin(sunPhase), 0.0);
  let azimuth = (hour - 12.0) * 3.14159 / 6.0;

  let x = cos(azimuth) * 0.3 + 0.3;
  let y = sin(azimuth) * 0.2 + 0.2;
  let z = elevation * 0.9 + 0.1;

  return normalize(vec3<f32>(x, y, z));
}

// --- Fragment shader ---

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  // Normalize interpolated normal (interpolation denormalizes)
  let n = normalize(in.normal);
  let sunDir = getSunDirection(uniforms.time);

  // Lambertian diffuse — abs so both sides of sail are lit
  let diffuse = abs(dot(n, sunDir));

  // Quantize into discrete tones (cel-shading)
  var tone: f32;
  if (diffuse > 0.5) {
    tone = 1.0;       // lit — full brightness
  } else if (diffuse > 0.2) {
    tone = 0.96;      // slight shadow
  } else {
    tone = 0.92;      // shadow
  }

  let tintedColor = vec3<f32>(
    uniforms.baseColor.r * tone,
    uniforms.baseColor.g * tone,
    uniforms.baseColor.b * tone,
  );

  return vec4<f32>(tintedColor, uniforms.baseColor.a);
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
      SAIL_SHADER_SOURCE,
      "Sail Shader",
    );

    bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
      label: "Sail Bind Group Layout",
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
      label: "Sail Pipeline Layout",
    });

    const vertexBufferLayout: GPUVertexBufferLayout = {
      arrayStride: SAIL_VERTEX_STRIDE,
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x2" }, // position
        { shaderLocation: 1, offset: 8, format: "float32x3" }, // normal
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

    // Pipeline for main render pass (has depth attachment).
    // Sails use the same depth mode as the boat layer (read-write)
    // so the surface shader knows the boat is present at sail pixels.
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
      label: "Sail Pipeline",
    });
  })();

  return initPromise;
}

/**
 * Per-sail GPU resources: vertex/index/uniform buffers and bind group.
 * Each ClothRenderer creates one of these.
 */
export class SailShaderInstance {
  private vertexBuffer: GPUBuffer | null = null;
  private indexBuffer: GPUBuffer | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private uniforms = SailUniforms.create();
  private readonly maxVertices: number;
  private readonly maxIndices: number;
  /** Scratch matrix for combining view + camera transforms. */
  private readonly combinedMatrix = new Matrix3();

  constructor(maxVertices: number, maxIndices: number) {
    this.maxVertices = maxVertices;
    this.maxIndices = maxIndices;
  }

  /** Lazily create GPU buffers. Returns false if not ready yet. */
  private ensureBuffers(): boolean {
    if (this.vertexBuffer) return true;
    if (!pipelineWithDepth || !bindGroupLayout) return false;

    const device = getWebGPU().device;

    this.vertexBuffer = device.createBuffer({
      size: this.maxVertices * SAIL_VERTEX_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      label: "Sail Vertex Buffer",
    });

    // Pad index buffer to 4-byte multiple
    const indexBufferSize = Math.ceil((this.maxIndices * 2) / 4) * 4;
    this.indexBuffer = device.createBuffer({
      size: indexBufferSize,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      label: "Sail Index Buffer",
    });

    this.uniformBuffer = device.createBuffer({
      size: SailUniforms.byteSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Sail Uniform Buffer",
    });

    this.bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer },
        },
      ],
      label: "Sail Bind Group",
    });

    return true;
  }

  /**
   * Upload vertex data and draw.
   * Call renderer.flush() before this.
   */
  draw(
    renderer: WebGPURenderer,
    vertexData: Float32Array,
    vertexCount: number,
    indexData: Uint16Array,
    indexCount: number,
    color: number,
    alpha: number,
    time: number,
  ): void {
    // Kick off async init if not done yet
    if (!pipelineWithDepth) {
      ensureInitialized();
      return; // Skip this frame, will render next frame
    }

    if (!this.ensureBuffers()) return;

    const device = getWebGPU().device;
    const renderPass = renderer.getCurrentRenderPass();
    if (!renderPass) return;

    // Upload vertex data
    const vData = vertexData.subarray(0, vertexCount * SAIL_VERTEX_SIZE);
    device.queue.writeBuffer(
      this.vertexBuffer!,
      0,
      vData.buffer,
      vData.byteOffset,
      vData.byteLength,
    );

    // Upload index data — caller pre-pads indexData to even length (4-byte multiple)
    device.queue.writeBuffer(
      this.indexBuffer!,
      0,
      indexData.buffer,
      indexData.byteOffset,
      indexData.byteLength,
    );

    // Upload uniforms
    // Combine camera transform (world → screen pixels) with view matrix (pixels → clip)
    // so the shader only needs: combinedMatrix * vec3(worldPos, 1.0)
    const baseR = ((color >> 16) & 0xff) / 255;
    const baseG = ((color >> 8) & 0xff) / 255;
    const baseB = (color & 0xff) / 255;
    // viewMatrix converts screen pixels → clip space
    // getTransform() is the current camera transform (world → screen pixels)
    // Combined: world → screen → clip
    this.combinedMatrix.copyFrom(renderer.getViewMatrix());
    this.combinedMatrix.multiply(renderer.getTransform());
    this.uniforms.set.viewMatrix(this.combinedMatrix);
    this.uniforms.set.baseColor([baseR, baseG, baseB, alpha]);
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
