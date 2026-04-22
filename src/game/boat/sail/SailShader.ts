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
  mat3x3,
  vec4,
} from "../../../core/graphics/UniformStruct";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import {
  getMSAASampleCount,
  onMSAAChange,
} from "../../../core/graphics/webgpu/MSAAState";
import {
  DEPTH_Z_MAX,
  DEPTH_Z_MIN,
  type WebGPURenderer,
} from "../../../core/graphics/webgpu/WebGPURenderer";
import {
  SCENE_LIGHTING_FIELDS,
  pushSceneLighting,
} from "../../time/SceneLighting";
import type { TimeOfDay } from "../../time/TimeOfDay";

/** 6 floats per vertex: position (2) + normal (3) + z (1) */
export const SAIL_VERTEX_SIZE = 6;
const SAIL_VERTEX_STRIDE = SAIL_VERTEX_SIZE * 4; // 24 bytes

const SailUniforms = defineUniformStruct("SailUniforms", {
  viewMatrix: mat3x3,
  baseColor: vec4,
  // Scene lighting (see SceneLighting.ts). Populated from TimeOfDay.
  ...SCENE_LIGHTING_FIELDS,
});

const SAIL_SHADER_SOURCE = /*wgsl*/ `
${SailUniforms.wgsl}

// Depth mapping — must match WebGPURenderer constants
const Z_MIN: f32 = ${DEPTH_Z_MIN};
const Z_MAX: f32 = ${DEPTH_Z_MAX};

@group(0) @binding(0) var<uniform> uniforms: SailUniforms;

struct VertexInput {
  @location(0) position: vec2<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) z: f32,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) normal: vec3<f32>,
}

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
  let worldPos = vec3<f32>(in.position, 1.0);
  let clipPos = uniforms.viewMatrix * worldPos;

  let depth = (in.z - Z_MIN) / (Z_MAX - Z_MIN);

  var out: VertexOutput;
  out.position = vec4<f32>(clipPos.xy, depth, 1.0);
  out.normal = in.normal;
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  // Normalize interpolated normal (interpolation denormalizes)
  let n = normalize(in.normal);

  // Lambertian diffuse — abs so both sides of sail are lit
  let diffuse = abs(dot(n, uniforms.sunDirection));

  // Quantize into discrete tones (cel-shading)
  var tone: f32;
  if (diffuse > 0.5) {
    tone = 1.0;       // lit — full brightness
  } else if (diffuse > 0.2) {
    tone = 0.96;      // slight shadow
  } else {
    tone = 0.92;      // shadow
  }

  // Ambient (sky) + directional (sun * cel tone). Sky keeps sails visible
  // at night as a cool-blue floor; sun warms them at sunrise/sunset and
  // reads as bright white at midday.
  let ambient = 0.5;
  let illumination = uniforms.skyColor * ambient + uniforms.sunColor * tone;
  let tintedColor = uniforms.baseColor.rgb * illumination;

  return vec4<f32>(tintedColor, uniforms.baseColor.a);
}
`;

// Module-level singleton state
let pipelineWithDepth: GPURenderPipeline | null = null;
let bindGroupLayout: GPUBindGroupLayout | null = null;
let initPromise: Promise<void> | null = null;
let shaderModule: GPUShaderModule | null = null;
let pipelineLayout: GPUPipelineLayout | null = null;
let msaaSubscribed = false;

function rebuildSailPipeline(): void {
  if (!shaderModule || !pipelineLayout) return;
  const gpu = getWebGPU();
  const device = gpu.device;
  const vertexBufferLayout: GPUVertexBufferLayout = {
    arrayStride: SAIL_VERTEX_STRIDE,
    attributes: [
      { shaderLocation: 0, offset: 0, format: "float32x2" }, // position
      { shaderLocation: 1, offset: 8, format: "float32x3" }, // normal
      { shaderLocation: 2, offset: 20, format: "float32" }, // z
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
    multisample: { count: getMSAASampleCount() },
    label: "Sail Pipeline",
  });
}

async function ensureInitialized(): Promise<void> {
  if (pipelineWithDepth) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const gpu = getWebGPU();
    const device = gpu.device;

    shaderModule = await gpu.createShaderModuleChecked(
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

    pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
      label: "Sail Pipeline Layout",
    });

    rebuildSailPipeline();

    if (!msaaSubscribed) {
      msaaSubscribed = true;
      onMSAAChange(rebuildSailPipeline);
    }
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
    timeOfDay: TimeOfDay | null,
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
    pushSceneLighting(this.uniforms.set, timeOfDay);
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
