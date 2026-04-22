/**
 * Custom WebGPU render pipeline for procedural rope rendering.
 *
 * Unified laid/braid shader: renders both traditional twisted-laid rope and
 * plaited-braid rope using a single diamond-grid fragment function. Each rope
 * carries a set of per-carrier colors; the shader samples them based on the
 * construction type (one strand family for laid, two crossing families with
 * over/under checkerboard for braid).
 *
 * Follows the SailShader pattern: module-level singleton pipeline, per-rope
 * instance with its own GPU buffers.
 */

import { Matrix3 } from "../../core/graphics/Matrix3";
import {
  defineUniformStruct,
  f32,
  mat3x3,
  u32,
  vec3,
  vec4u,
} from "../../core/graphics/UniformStruct";
import type { TimeOfDay } from "../time/TimeOfDay";
import { getWebGPU } from "../../core/graphics/webgpu/WebGPUDevice";
import {
  getMSAASampleCount,
  onMSAAChange,
} from "../../core/graphics/webgpu/MSAAState";
import {
  DEPTH_Z_MAX,
  DEPTH_Z_MIN,
  type WebGPURenderer,
} from "../../core/graphics/webgpu/WebGPURenderer";
import { ROPE_VERTEX_FLOATS } from "./tessellation";

/** 5 floats per vertex: position (2) + uv (2) + z (1) */
const ROPE_VERTEX_STRIDE = ROPE_VERTEX_FLOATS * 4; // 20 bytes

/**
 * Maximum carrier slots supported by the shader.
 * Covers up to 32-plait asymmetric braid (16 S-laid + 16 Z-laid) or a
 * 32-strand laid rope. Most sailing lines are 8-16 plait.
 */
export const MAX_CARRIERS = 32;

/**
 * Describes the visual construction of a rope.
 *
 * - `type: "laid"` — traditional twisted rope. `carriers` entries are the
 *   individual strand colors (typically 3 for classic 3-strand rope).
 * - `type: "braid"` — plaited cover. `carriers` splits into two equal halves:
 *   first half is the S-laid family, second is the Z-laid family. Length
 *   must be even and equals the total plait count (8 = 8-plait, 16 = 16-plait).
 */
export interface RopePattern {
  type: "laid" | "braid";
  carriers: number[];
  /**
   * Weave pattern as `[over, under]` cell counts. Only used for braid.
   * Default `[1, 1]` (plain weave: alternates every cell).
   * `[2, 2]` = 2/2 twill (classic Marlowbraid look).
   * `[1, 2]` = asymmetric: S-laid carriers spend 1/3 of cells on top,
   * Z-laid carriers dominate the surface.
   */
  weave?: [number, number];
  /**
   * Helix angle of the carriers from the rope axis, in degrees.
   * Default 45°. Real sailing lines are often 30-40° (shallower braid,
   * more elongated diamonds). Values > 45° make wide, squished diamonds.
   */
  helixAngle?: number;
}

const RopeUniforms = defineUniformStruct("RopeUniforms", {
  viewMatrix: mat3x3,
  alpha: f32,
  twistFrequency: f32,
  carriersPerFamily: u32,
  isBraid: u32,
  weaveOver: u32,
  weaveUnder: u32,
  helixScale: f32,
  // Global scene illumination (sun + sky), pushed per-frame from TimeOfDay.
  ambientLight: vec3,
  // 8 × vec4<u32> = 32 carrier slots, packed 0xRRGGBB.
  carriers0: vec4u,
  carriers1: vec4u,
  carriers2: vec4u,
  carriers3: vec4u,
  carriers4: vec4u,
  carriers5: vec4u,
  carriers6: vec4u,
  carriers7: vec4u,
});

const ROPE_SHADER_SOURCE = /*wgsl*/ `
${RopeUniforms.wgsl}

// Depth mapping — must match WebGPURenderer constants
const Z_MIN: f32 = ${DEPTH_Z_MIN};
const Z_MAX: f32 = ${DEPTH_Z_MAX};
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
  // Small depth bias to break z-fighting with deck geometry that sits at
  // the same world z (different depth computation paths: rope shader vs
  // shape shader with tilt transform). Kept tiny so deck hardware drawn
  // above the rope at rope_z + small Δ wins on the depth test.
  let depth = (in.z - Z_MIN) / (Z_MAX - Z_MIN) + 0.0001;

  var out: VertexOutput;
  out.position = vec4<f32>(clipPos.xy, depth, 1.0);
  out.uv = in.uv;
  return out;
}

fn unpackRGB(packed: u32) -> vec3<f32> {
  return vec3<f32>(
    f32((packed >> 16u) & 0xFFu) / 255.0,
    f32((packed >> 8u) & 0xFFu) / 255.0,
    f32(packed & 0xFFu) / 255.0
  );
}

fn getCarrierColor(id: u32) -> vec3<f32> {
  let chunk = id >> 2u;   // which vec4<u32> (0-7)
  let lane = id & 3u;     // which element within vec4 (0-3)
  var v: vec4<u32>;
  switch chunk {
    case 0u: { v = uniforms.carriers0; }
    case 1u: { v = uniforms.carriers1; }
    case 2u: { v = uniforms.carriers2; }
    case 3u: { v = uniforms.carriers3; }
    case 4u: { v = uniforms.carriers4; }
    case 5u: { v = uniforms.carriers5; }
    case 6u: { v = uniforms.carriers6; }
    case 7u: { v = uniforms.carriers7; }
    default: { v = uniforms.carriers0; }
  }
  return unpackRGB(v[lane]);
}

// --- Unified rope pattern ---
// Scales UV into a diamond grid sized so carriersPerFamily/2 diamonds fit
// across the visible width (matches the circumference geometry of real rope).
// For laid: samples one diagonal only → parallel helical stripes.
// For braid: samples both diagonals with a checkerboard → diamond weave with
// independent S-laid and Z-laid families.

// Evaluate the procedural pattern at a single (u, v) sample, returning the
// carrier color for that cell. Cheap — a handful of floor/mod ops.
fn sampleCarrier(u: f32, v: f32) -> vec3<f32> {
  let cpf = f32(uniforms.carriersPerFamily);
  let nVisible = cpf * 0.5;

  // Recover physical rope width from twist frequency (2π / (8 * width)).
  let ropeWidth = 2.0 * PI / (8.0 * uniforms.twistFrequency);

  // Orthographic cylinder projection: screen u → surface angle via asin.
  let su = asin(clamp(u, -1.0, 1.0)) * nVisible / PI;
  let sv = v * nVisible / ropeWidth;
  let hs = uniforms.helixScale;

  let du = su + sv * hs;
  let ci = floor(du);
  let sId = ((ci % cpf) + cpf) % cpf;

  var carrierIdx: u32;
  if (uniforms.isBraid == 0u) {
    carrierIdx = u32(sId);
  } else {
    let dv = -su + sv * hs;
    let cj = floor(dv);
    let period = f32(uniforms.weaveOver + uniforms.weaveUnder);
    let phase = ((ci + cj) % period + period) % period;
    let isOver = phase < f32(uniforms.weaveOver);
    let zId = ((cj % cpf) + cpf) % cpf;
    if (isOver) {
      carrierIdx = u32(sId);
    } else {
      carrierIdx = u32(zId) + uniforms.carriersPerFamily;
    }
  }
  return getCarrierColor(carrierIdx);
}

// Adaptive supersampling: evaluate the pattern multiple times per fragment
// when the strand cells shrink below pixel size, resolving shimmer.
// Grid dimension N is chosen from the screen-space cell density, so close-up
// ropes run a single tap and only distant/thin ropes pay for more samples.
// NMax = 4 → at most 16 taps at the heaviest LOD.
@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let u = in.uv.x;
  let v = in.uv.y;

  // Derivatives MUST be taken in uniform control flow, so compute them up
  // front before any data-dependent branching.
  let dudx = dpdx(u);
  let dudy = dpdy(u);
  let dvdx = dpdx(v);
  let dvdy = dpdy(v);

  // Estimate cells-per-pixel along the dominant pattern diagonal so we can
  // size the supersample grid. Uses the same coordinate transform as
  // sampleCarrier(), linearized: d(asin)/du ≈ 1/sqrt(1-u²).
  let cpf = f32(uniforms.carriersPerFamily);
  let nVisible = cpf * 0.5;
  let ropeWidth = 2.0 * PI / (8.0 * uniforms.twistFrequency);
  let asinScale = 1.0 / sqrt(max(1.0 - u * u, 1e-4));
  let suPerU = asinScale * nVisible / PI;
  let svPerV = nVisible / ropeWidth;
  let hs = uniforms.helixScale;
  // |d(du)/dx| + |d(du)/dy| — derivative of the first diagonal in screen px.
  let fwDu = abs(suPerU * dudx + hs * svPerV * dvdx)
           + abs(suPerU * dudy + hs * svPerV * dvdy);
  let fwDv = abs(-suPerU * dudx + hs * svPerV * dvdx)
           + abs(-suPerU * dudy + hs * svPerV * dvdy);
  let cellsPerPixel = select(fwDu, max(fwDu, fwDv), uniforms.isBraid != 0u);

  // Nyquist: need ~2 samples per cell along the worst axis. With an NxN
  // grid each tap covers 1/N of a pixel, so we want N ≈ 2*cellsPerPixel.
  // Clamp to [1, 4]; 4 means 16 taps, reserved for heavily-compressed ropes.
  let nF = clamp(ceil(2.0 * cellsPerPixel), 1.0, 4.0);
  let N = i32(nF);

  var acc = vec3<f32>(0.0);
  let invN = 1.0 / nF;
  for (var j = 0; j < N; j = j + 1) {
    let sy = (f32(j) + 0.5) * invN - 0.5;
    for (var i = 0; i < N; i = i + 1) {
      let sx = (f32(i) + 0.5) * invN - 0.5;
      let uu = u + sx * dudx + sy * dudy;
      let vv = v + sx * dvdx + sy * dvdy;
      acc = acc + sampleCarrier(uu, vv);
    }
  }
  let color = acc / f32(N * N);
  return vec4<f32>(color * uniforms.ambientLight, uniforms.alpha);
}
`;

// Module-level singleton state
let pipelineWithDepth: GPURenderPipeline | null = null;
let bindGroupLayout: GPUBindGroupLayout | null = null;
let initPromise: Promise<void> | null = null;
let shaderModule: GPUShaderModule | null = null;
let pipelineLayout: GPUPipelineLayout | null = null;
let msaaSubscribed = false;

function rebuildRopePipeline(): void {
  if (!shaderModule || !pipelineLayout) return;
  const gpu = getWebGPU();
  const device = gpu.device;
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
    multisample: { count: getMSAASampleCount() },
    label: "Rope Pipeline",
  });
}

async function ensureInitialized(): Promise<void> {
  if (pipelineWithDepth) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const gpu = getWebGPU();
    const device = gpu.device;

    shaderModule = await gpu.createShaderModuleChecked(
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

    pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
      label: "Rope Pipeline Layout",
    });

    rebuildRopePipeline();

    if (!msaaSubscribed) {
      msaaSubscribed = true;
      onMSAAChange(rebuildRopePipeline);
    }
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
   * Upload vertex data and draw the rope with the given pattern.
   * Caller must have called renderer.flush() before this.
   */
  draw(
    renderer: WebGPURenderer,
    vertexData: Float32Array,
    vertexCount: number,
    indexData: Uint16Array,
    indexCount: number,
    pattern: RopePattern,
    alpha: number,
    ropeWidth: number,
    timeOfDay: TimeOfDay | null,
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

    // Derive shader parameters from the pattern
    const isBraid = pattern.type === "braid" ? 1 : 0;
    const carriersPerFamily =
      pattern.type === "braid"
        ? Math.floor(pattern.carriers.length / 2)
        : pattern.carriers.length;
    const cpf = Math.max(1, Math.min(carriersPerFamily, MAX_CARRIERS / 2));
    const weaveOver = Math.max(1, pattern.weave?.[0] ?? 1);
    const weaveUnder = Math.max(1, pattern.weave?.[1] ?? 1);
    const helixAngleDeg = pattern.helixAngle ?? 45;
    const helixScale = Math.tan((helixAngleDeg * Math.PI) / 180);

    // Upload uniforms
    this.combinedMatrix.copyFrom(renderer.getViewMatrix());
    this.combinedMatrix.multiply(renderer.getTransform());
    this.uniforms.set.viewMatrix(this.combinedMatrix);
    this.uniforms.set.alpha(alpha);
    this.uniforms.set.twistFrequency(
      (2 * Math.PI) / (8 * Math.max(ropeWidth, 0.01)),
    );
    this.uniforms.set.carriersPerFamily(cpf);
    this.uniforms.set.isBraid(isBraid);
    this.uniforms.set.weaveOver(weaveOver);
    this.uniforms.set.weaveUnder(weaveUnder);
    this.uniforms.set.helixScale(helixScale);
    this.uniforms.set.ambientLight(timeOfDay?.getAmbientLight() ?? [1, 1, 1]);

    // Pack carriers into 8 vec4<u32> slots. Pad with the first color.
    const pad = pattern.carriers[0] ?? 0x888888;
    const slots = [
      this.uniforms.set.carriers0,
      this.uniforms.set.carriers1,
      this.uniforms.set.carriers2,
      this.uniforms.set.carriers3,
      this.uniforms.set.carriers4,
      this.uniforms.set.carriers5,
      this.uniforms.set.carriers6,
      this.uniforms.set.carriers7,
    ];
    for (let chunk = 0; chunk < 8; chunk++) {
      const i = chunk * 4;
      slots[chunk]([
        pattern.carriers[i + 0] ?? pad,
        pattern.carriers[i + 1] ?? pad,
        pattern.carriers[i + 2] ?? pad,
        pattern.carriers[i + 3] ?? pad,
      ]);
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
