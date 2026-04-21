/**
 * Immediate-mode 2D WebGPU renderer.
 * All draw calls are batched and flushed at frame end or on state change.
 *
 * Architecture:
 * - Two batch types: shapes (untextured) and sprites (textured)
 * - Transform stack with Matrix3
 * - Batched rendering with automatic flushing
 */

import { CachedMesh } from "../CachedMesh";
import { DynamicMesh } from "../DynamicMesh";
import { hexToVec3 } from "../../util/ColorUtils";
import { CompatibleVector } from "../../Vector";
import { Matrix3 } from "../Matrix3";
import { type Transform, TransformBuffer } from "../TransformBuffer";
import {
  defineUniformStruct,
  mat3x3,
  type UniformInstance,
} from "../UniformStruct";
import { GPUProfiler, GPUProfileSection } from "./GPUProfiler";
import { getMSAASampleCount, isMSAAEnabled, onMSAAChange } from "./MSAAState";
import { SHAPE_VERTEX_FLOATS, ShapeBatch } from "./ShapeBatch";
import { SPRITE_VERTEX_FLOATS, SpriteBatch } from "./SpriteBatch";
import { getWebGPU } from "./WebGPUDevice";
import { WebGPUTexture, WebGPUTextureManager } from "./WebGPUTextureManager";

// Depth mapping constants — shared between shape/sprite shaders and surface shader.
// World z-heights are linearly mapped to NDC depth [0, 1].
// Higher z = closer to viewer. depthCompare: "greater-equal" means higher depth wins.
//
// Z_MIN is set to the deepest underwater visibility horizon across the
// range of water chemistry presets the game supports. With clean coastal
// water (chlorophyll ~0.1), blue-channel extinction is ~0.02/ft and light
// from 260ft down is attenuated to the 8-bit quantization threshold
// (~0.4%). With pristine open ocean it stretches further. -300ft gives
// headroom for cleaner presets without clipping terrain or sunken objects.
// Depth buffer precision at 330ft range is still ~20µm (24-bit depth).
export const DEPTH_Z_MIN = -300.0;
export const DEPTH_Z_MAX = 100.0;
const DEPTH_FORMAT: GPUTextureFormat = "depth24plus";

// MSAA sample count at process start. Kept for backwards compatibility; live
// MSAA-aware code should call getMSAASampleCount() so it stays in sync with
// runtime toggles. See MSAAState.ts.
export const MSAA_SAMPLE_COUNT = getMSAASampleCount();

// Transform struct (std430) shared by shape + sprite shaders.
// Matches TransformBuffer.ts CPU layout: 16 floats / 64 bytes.
const transformStructWGSL = /*wgsl*/ `
struct Transform {
  modelCol0: vec2<f32>,
  modelCol1: vec2<f32>,
  modelCol2: vec2<f32>,
  zCoeffs:   vec2<f32>,
  zDepth:    vec4<f32>,  // (zRow.x, zRow.y, zRow.z, zBase)
  tint:      vec4<f32>,
}
`;

// Shape shader: Renders untextured colored primitives with optional depth
const shapeShaderSource = /*wgsl*/ `
const Z_MIN: f32 = ${DEPTH_Z_MIN};
const Z_MAX: f32 = ${DEPTH_Z_MAX};

struct Uniforms {
  viewMatrix: mat3x3<f32>,
}

${transformStructWGSL}

struct VertexInput {
  @location(0) position: vec2<f32>,
  @location(1) color: vec4<f32>,
  @location(2) z: f32,
  @location(3) transformIndex: u32,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> transforms: array<Transform>;

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
  let t = transforms[in.transformIndex];
  let worldX = t.modelCol0.x * in.position.x + t.modelCol1.x * in.position.y
               + t.zCoeffs.x * in.z + t.modelCol2.x;
  let worldY = t.modelCol0.y * in.position.x + t.modelCol1.y * in.position.y
               + t.zCoeffs.y * in.z + t.modelCol2.y;
  let clipPos = uniforms.viewMatrix * vec3<f32>(worldX, worldY, 1.0);

  let depthZ = t.zDepth.w
             + t.zDepth.x * in.position.x
             + t.zDepth.y * in.position.y
             + t.zDepth.z * in.z;
  let depth = (depthZ - Z_MIN) / (Z_MAX - Z_MIN);

  var out: VertexOutput;
  out.position = vec4<f32>(clipPos.xy, depth, 1.0);
  out.color = in.color * t.tint;
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  return in.color;
}
`;

// Sprite shader: Renders textured quads with tinting and optional depth
const spriteShaderSource = /*wgsl*/ `
const Z_MIN: f32 = ${DEPTH_Z_MIN};
const Z_MAX: f32 = ${DEPTH_Z_MAX};

struct Uniforms {
  viewMatrix: mat3x3<f32>,
}

${transformStructWGSL}

struct VertexInput {
  @location(0) position: vec2<f32>,
  @location(1) texCoord: vec2<f32>,
  @location(2) color: vec4<f32>,
  @location(3) z: f32,
  @location(4) transformIndex: u32,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) texCoord: vec2<f32>,
  @location(1) color: vec4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var textureSampler: sampler;
@group(0) @binding(2) var<storage, read> transforms: array<Transform>;
@group(1) @binding(0) var spriteTexture: texture_2d<f32>;

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
  let t = transforms[in.transformIndex];
  let worldX = t.modelCol0.x * in.position.x + t.modelCol1.x * in.position.y
               + t.zCoeffs.x * in.z + t.modelCol2.x;
  let worldY = t.modelCol0.y * in.position.x + t.modelCol1.y * in.position.y
               + t.zCoeffs.y * in.z + t.modelCol2.y;
  let clipPos = uniforms.viewMatrix * vec3<f32>(worldX, worldY, 1.0);

  let depthZ = t.zDepth.w
             + t.zDepth.x * in.position.x
             + t.zDepth.y * in.position.y
             + t.zDepth.z * in.z;
  let depth = (depthZ - Z_MIN) / (Z_MAX - Z_MIN);

  var out: VertexOutput;
  out.position = vec4<f32>(clipPos.xy, depth, 1.0);
  out.texCoord = in.texCoord;
  out.color = in.color * t.tint;
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let texColor = textureSample(spriteTexture, textureSampler, in.texCoord);
  return texColor * in.color;
}
`;

/** Options for sprite drawing */
export interface SpriteOptions {
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  alpha?: number;
  tint?: number; // 0xRRGGBB
  anchorX?: number; // 0-1, default 0.5
  anchorY?: number; // 0-1, default 0.5
}

// Type-safe uniform buffer definition (view matrix only — per-instance
// transforms live in the TransformBuffer storage buffer).
const ViewUniforms = defineUniformStruct("Uniforms", {
  viewMatrix: mat3x3,
});

const UNIFORM_BUFFER_SIZE = ViewUniforms.byteSize;

/**
 * Immediate-mode 2D WebGPU renderer.
 */
export class WebGPURenderer {
  private static warningKeys = new Set<string>();

  readonly canvas: HTMLCanvasElement;
  readonly textureManager: WebGPUTextureManager;

  private context: GPUCanvasContext | null = null;
  private device: GPUDevice | null = null;

  // Pipeline variants:
  // Pipeline variants for different depth modes:
  // - default: depth always-pass, no-write (main pass, non-depth layers)
  // - depth: depth greater-equal, write (main pass, depth-tested layers)
  // - alwaysWrite: depth always-pass, write (main pass, boat layer — draws on top, writes z)
  // - noDepth: no depthStencil at all (offscreen passes without depth attachment)
  private shapePipeline: GPURenderPipeline | null = null;
  private shapePipelineDepth: GPURenderPipeline | null = null;
  private shapePipelineAlwaysWrite: GPURenderPipeline | null = null;
  private shapePipelineNoDepth: GPURenderPipeline | null = null;
  private spritePipeline: GPURenderPipeline | null = null;
  private spritePipelineDepth: GPURenderPipeline | null = null;
  private spritePipelineAlwaysWrite: GPURenderPipeline | null = null;
  private spritePipelineNoDepth: GPURenderPipeline | null = null;

  // Depth state
  private depthMode: "none" | "read-write" | "always-write" = "none";
  private inOffscreenPass = false;
  // MSAA depth render attachment — only exists when MSAA is enabled.
  private mainDepthTextureMS: GPUTexture | null = null;
  private mainDepthTextureMSView: GPUTextureView | null = null;
  // 1x depth — always exists.
  //   MSAA on:  written by the depth-resolve pass, sampled by overlays.
  //   MSAA off: the render attachment itself.
  private mainDepthTexture: GPUTexture | null = null;
  private mainDepthTextureView: GPUTextureView | null = null;
  // Separate 1x sampleable copy of the depth buffer. Only used when MSAA is
  // disabled (then mainDepthTexture is the render attachment and can't be
  // sampled in the same pass). Populated by copyTextureToTexture.
  private depthCopyTexture: GPUTexture | null = null;
  private depthCopyTextureView: GPUTextureView | null = null;

  // Intermediate color buffer — scene renders here, then water filter reads
  // a copy and outputs to the swapchain. Enables the water filter to apply
  // physically-based absorption to already-drawn content.
  //   MSAA on:  mainColorTextureMS is the render attachment, mainColorTexture
  //             is its 1x resolve target.
  //   MSAA off: mainColorTexture is the render attachment directly; the MS
  //             fields are null.
  private mainColorTextureMS: GPUTexture | null = null;
  private mainColorTextureMSView: GPUTextureView | null = null;
  private mainColorTexture: GPUTexture | null = null;
  private mainColorTextureView: GPUTextureView | null = null;
  private colorCopyTexture: GPUTexture | null = null;
  private colorCopyTextureView: GPUTextureView | null = null;
  // Swapchain texture for this frame (stored in beginFrame for endFrame fallback)
  private swapchainTexture: GPUTexture | null = null;
  // True once copyColorBuffer has been called this frame (render target now
  // points to swapchain). If false at endFrame, mainColorTexture is blitted
  // to the swapchain as a fallback (e.g. editor mode with no water filter).
  private colorCopied = false;

  // Z-height state for 3D tilt projection (saved/restored with transform stack).
  //
  // The tilt context decomposes the 3×3 Yaw·Pitch·Roll rotation matrix R into:
  //   zCoeffs = R's z-column (R[0,2], R[1,2]) — maps local z → screen xy offset (parallax)
  //   zRow    = R's z-row    (R[2,0], R[2,1], R[2,2]) — maps local (x,y,z) → world z (depth)
  //   currentZ = body's world z position (additive base for depth)
  //
  // World z for depth: worldZ = currentZ + zRowX·localX + zRowY·localY + zRowZ·localZ
  // Default zRow (0,0,1) passes local z through unchanged (no tilt).
  private currentZ = 0;
  private currentZCoeffX = 0;
  private currentZCoeffY = 0;
  private currentZRowX = 0;
  private currentZRowY = 0;
  private currentZRowZ = 1;
  private zStack: number[][] = [];

  // Batch state — vertex/index CPU + GPU resources live on these classes.
  private shapeBatch = new ShapeBatch();
  private spriteBatch = new SpriteBatch();

  // Per-instance transform storage.
  private transformBuffer = new TransformBuffer();
  // Pending transform state gets lazily allocated into transformBuffer on
  // the next submit after any state change. `pendingTransformDirty` marks
  // that `shapeBatch.currentTransformIndex` / `spriteBatch.currentTransformIndex`
  // are stale and need to be refreshed.
  private pendingTransformDirty = true;

  // Shape pipeline / bind-group resources
  private shapeUniformBuffer: GPUBuffer | null = null;
  private shapeBindGroup: GPUBindGroup | null = null;

  // Sprite pipeline / bind-group resources
  private spriteUniformBuffer: GPUBuffer | null = null;
  private spriteBindGroupLayout: GPUBindGroupLayout | null = null;
  private spriteTextureBindGroupLayout: GPUBindGroupLayout | null = null;
  private spriteUniformBindGroup: GPUBindGroup | null = null;
  private currentTexture: WebGPUTexture | null = null;
  private currentTextureBindGroup: GPUBindGroup | null = null;
  private textureBindGroupCache: Map<WebGPUTexture, GPUBindGroup> = new Map();

  // Default sampler for sprites
  private defaultSampler: GPUSampler | null = null;

  // Transform stack
  private transformStack: Matrix3[] = [];
  private currentTransform: Matrix3 = new Matrix3();

  // View matrix (screen projection)
  private viewMatrix: Matrix3 = new Matrix3();

  // Stats for debugging
  private drawCallCount = 0;
  private triangleCount = 0;
  private vertexCount = 0;
  private lastDrawCallCount = 0;
  private lastTriangleCount = 0;
  private lastVertexCount = 0;

  // Pixel ratio for high-DPI displays
  private pixelRatio = 1;

  // Type-safe uniform instance
  private viewUniforms: UniformInstance<typeof ViewUniforms.fields> =
    ViewUniforms.create();

  // Pre-allocated Matrix3 for building sprite transforms
  private spriteMatrix: Matrix3 = new Matrix3();

  // Current render pass encoder (set during frame)
  private currentCommandEncoder: GPUCommandEncoder | null = null;
  private currentRenderPass: GPURenderPassEncoder | null = null;
  private currentRenderTarget: GPUTextureView | null = null;
  // Resolve target for MSAA — paired with currentRenderTarget. Null in
  // offscreen passes (which are 1x and don't resolve).
  private currentResolveTarget: GPUTextureView | null = null;

  // Pipeline used by copyDepthBuffer() to resolve MSAA depth → 1x depth.
  private depthResolvePipeline: GPURenderPipeline | null = null;
  private depthResolveBindGroupLayout: GPUBindGroupLayout | null = null;

  // Cached inputs for MSAA-sensitive pipeline rebuilds.
  private shapeShaderModule: GPUShaderModule | null = null;
  private shapePipelineLayout: GPUPipelineLayout | null = null;
  private shapeVertexBufferLayout: GPUVertexBufferLayout | null = null;
  private shapeTxIndexBufferLayout: GPUVertexBufferLayout | null = null;
  private spriteShaderModule: GPUShaderModule | null = null;
  private spritePipelineLayout: GPUPipelineLayout | null = null;
  private spriteVertexBufferLayout: GPUVertexBufferLayout | null = null;
  private spriteTxIndexBufferLayout: GPUVertexBufferLayout | null = null;
  private pipelinePrimitiveState: GPUPrimitiveState | null = null;
  private unsubscribeMSAA: (() => void) | null = null;

  // Track initialization state
  private initialized = false;

  // GPU profiler (null if timestamp queries not supported)
  private gpuProfiler: GPUProfiler | null = null;

  constructor(canvas?: HTMLCanvasElement) {
    this.canvas = canvas ?? document.createElement("canvas");
    this.textureManager = new WebGPUTextureManager();
    // shapeBatch / spriteBatch / transformBuffer allocate their CPU-side
    // Float32Array / Uint32Array storage in their own constructors.
  }

  private warnOnce(key: string, message: string): void {
    if (WebGPURenderer.warningKeys.has(key)) return;
    WebGPURenderer.warningKeys.add(key);
    console.warn(message);
  }

  /**
   * Initialize WebGPU resources.
   * Must be called after WebGPUDevice.init().
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    const gpuManager = getWebGPU();
    this.device = gpuManager.device;

    // Configure canvas context
    this.context = this.canvas.getContext("webgpu") as GPUCanvasContext;
    if (!this.context) {
      throw new Error("Failed to get WebGPU canvas context");
    }

    this.context.configure({
      device: this.device,
      format: gpuManager.preferredFormat,
      alphaMode: "opaque",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
    });

    // Create default sampler
    this.defaultSampler = this.device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    // Create shape pipeline and resources
    await this.createShapePipeline();

    // Create sprite pipeline and resources
    await this.createSpritePipeline();

    // Listen for runtime MSAA toggles and rebuild textures/pipelines in sync.
    this.unsubscribeMSAA = onMSAAChange(() => this.rebuildForMSAA());

    this.initialized = true;
  }

  private async createShapePipeline(): Promise<void> {
    if (!this.device) return;

    const gpu = getWebGPU();
    const device = this.device;
    this.pipelinePrimitiveState = {
      topology: "triangle-list",
      ...(gpu.features.depthClipControl ? { unclippedDepth: true } : {}),
    };
    const primitiveState = this.pipelinePrimitiveState;

    // Create shader module
    const shaderModule = await gpu.createShaderModuleChecked(
      shapeShaderSource,
      "Shape Shader",
    );
    this.shapeShaderModule = shaderModule;

    // Create uniform buffer
    this.shapeUniformBuffer = device.createBuffer({
      size: UNIFORM_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Shape Uniform Buffer",
    });

    // Ensure the transform storage buffer exists before building the bind group.
    const transformGpuBuffer = this.transformBuffer.ensureGpuBuffer(device);

    // Create bind group layout: uniforms (0), transforms (1).
    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "read-only-storage" },
        },
      ],
      label: "Shape Bind Group Layout",
    });

    this.shapeBindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.shapeUniformBuffer } },
        { binding: 1, resource: { buffer: transformGpuBuffer } },
      ],
      label: "Shape Bind Group",
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
      label: "Shape Pipeline Layout",
    });
    this.shapePipelineLayout = pipelineLayout;

    // Two-stream vertex layout: geometry + transformIndex.
    const geometryStride = SHAPE_VERTEX_FLOATS * 4; // 28 bytes
    const geometryLayout: GPUVertexBufferLayout = {
      arrayStride: geometryStride,
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x2" }, // position
        { shaderLocation: 1, offset: 8, format: "float32x4" }, // color
        { shaderLocation: 2, offset: 24, format: "float32" }, // z
      ],
    };
    const txIndexLayout: GPUVertexBufferLayout = {
      arrayStride: 4,
      attributes: [
        { shaderLocation: 3, offset: 0, format: "uint32" }, // transformIndex
      ],
    };
    this.shapeVertexBufferLayout = geometryLayout;
    this.shapeTxIndexBufferLayout = txIndexLayout;

    const fragmentState: GPUFragmentState = {
      module: shaderModule,
      entryPoint: "fs_main",
      targets: [
        {
          format: getWebGPU().preferredFormat,
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
      buffers: [geometryLayout, txIndexLayout],
    };

    // Depth-attached pipelines (MSAA-sensitive) — extracted so they can be
    // rebuilt when the MSAA toggle changes.
    this.rebuildShapeMSAAPipelines();

    // Create pipeline without any depthStencil (for offscreen passes without depth attachment)
    this.shapePipelineNoDepth = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: vertexState,
      fragment: fragmentState,
      primitive: primitiveState,
      label: "Shape Pipeline (No Depth)",
    });

    // Allocate batch GPU buffers (vertex, txIndex, index streams).
    this.shapeBatch.createGpuBuffers(device);
  }

  private async createSpritePipeline(): Promise<void> {
    if (!this.device) return;

    const gpu = getWebGPU();
    const device = this.device;
    const primitiveState: GPUPrimitiveState = this.pipelinePrimitiveState ?? {
      topology: "triangle-list",
      ...(gpu.features.depthClipControl ? { unclippedDepth: true } : {}),
    };

    // Create shader module
    const shaderModule = await gpu.createShaderModuleChecked(
      spriteShaderSource,
      "Sprite Shader",
    );
    this.spriteShaderModule = shaderModule;

    // Create uniform buffer
    this.spriteUniformBuffer = device.createBuffer({
      size: UNIFORM_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Sprite Uniform Buffer",
    });

    const transformGpuBuffer = this.transformBuffer.ensureGpuBuffer(device);

    // Create bind group layout for uniforms + sampler + transforms (group 0)
    this.spriteBindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "read-only-storage" },
        },
      ],
      label: "Sprite Uniform Bind Group Layout",
    });

    // Create bind group layout for texture (group 1)
    this.spriteTextureBindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
      ],
      label: "Sprite Texture Bind Group Layout",
    });

    this.spriteUniformBindGroup = device.createBindGroup({
      layout: this.spriteBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.spriteUniformBuffer } },
        { binding: 1, resource: this.defaultSampler! },
        { binding: 2, resource: { buffer: transformGpuBuffer } },
      ],
      label: "Sprite Uniform Bind Group",
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [
        this.spriteBindGroupLayout,
        this.spriteTextureBindGroupLayout,
      ],
      label: "Sprite Pipeline Layout",
    });
    this.spritePipelineLayout = pipelineLayout;

    // Two-stream vertex layout: geometry (9 floats) + transformIndex (u32).
    const geometryStride = SPRITE_VERTEX_FLOATS * 4; // 36 bytes
    const geometryLayout: GPUVertexBufferLayout = {
      arrayStride: geometryStride,
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x2" }, // position
        { shaderLocation: 1, offset: 8, format: "float32x2" }, // texCoord
        { shaderLocation: 2, offset: 16, format: "float32x4" }, // color
        { shaderLocation: 3, offset: 32, format: "float32" }, // z
      ],
    };
    const txIndexLayout: GPUVertexBufferLayout = {
      arrayStride: 4,
      attributes: [
        { shaderLocation: 4, offset: 0, format: "uint32" }, // transformIndex
      ],
    };
    this.spriteVertexBufferLayout = geometryLayout;
    this.spriteTxIndexBufferLayout = txIndexLayout;

    const fragmentState: GPUFragmentState = {
      module: shaderModule,
      entryPoint: "fs_main",
      targets: [
        {
          format: getWebGPU().preferredFormat,
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
      buffers: [geometryLayout, txIndexLayout],
    };

    // Depth-attached pipelines (MSAA-sensitive) — extracted so they can be
    // rebuilt when the MSAA toggle changes.
    this.rebuildSpriteMSAAPipelines();

    // Create pipeline without any depthStencil (for offscreen passes without depth attachment)
    this.spritePipelineNoDepth = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: vertexState,
      fragment: fragmentState,
      primitive: primitiveState,
      label: "Sprite Pipeline (No Depth)",
    });

    this.spriteBatch.createGpuBuffers(device);

    // Initialize GPU profiler if timestamp queries are supported
    const gpuManager = getWebGPU();
    if (gpuManager.features.timestampQuery) {
      this.gpuProfiler = new GPUProfiler(device);
      this.gpuProfiler.setEnabled(true);
    }
  }

  /** Rebuild the 3 depth-attached shape pipelines at the current MSAA count. */
  private rebuildShapeMSAAPipelines(): void {
    if (
      !this.device ||
      !this.shapeShaderModule ||
      !this.shapePipelineLayout ||
      !this.shapeVertexBufferLayout ||
      !this.shapeTxIndexBufferLayout ||
      !this.pipelinePrimitiveState
    )
      return;
    const device = this.device;
    const format = getWebGPU().preferredFormat;
    const vertexState: GPUVertexState = {
      module: this.shapeShaderModule,
      entryPoint: "vs_main",
      buffers: [this.shapeVertexBufferLayout, this.shapeTxIndexBufferLayout],
    };
    const fragmentState: GPUFragmentState = {
      module: this.shapeShaderModule,
      entryPoint: "fs_main",
      targets: [
        {
          format,
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
    const msaa: GPUMultisampleState = { count: getMSAASampleCount() };
    const base = {
      layout: this.shapePipelineLayout,
      vertex: vertexState,
      fragment: fragmentState,
      primitive: this.pipelinePrimitiveState,
      multisample: msaa,
    };
    this.shapePipeline = device.createRenderPipeline({
      ...base,
      depthStencil: {
        format: DEPTH_FORMAT,
        depthCompare: "always",
        depthWriteEnabled: false,
      },
      label: "Shape Pipeline",
    });
    this.shapePipelineDepth = device.createRenderPipeline({
      ...base,
      depthStencil: {
        format: DEPTH_FORMAT,
        depthCompare: "greater-equal",
        depthWriteEnabled: true,
      },
      label: "Shape Pipeline (Depth)",
    });
    this.shapePipelineAlwaysWrite = device.createRenderPipeline({
      ...base,
      depthStencil: {
        format: DEPTH_FORMAT,
        depthCompare: "always",
        depthWriteEnabled: true,
      },
      label: "Shape Pipeline (Always Write)",
    });
  }

  /** Rebuild the 3 depth-attached sprite pipelines at the current MSAA count. */
  private rebuildSpriteMSAAPipelines(): void {
    if (
      !this.device ||
      !this.spriteShaderModule ||
      !this.spritePipelineLayout ||
      !this.spriteVertexBufferLayout ||
      !this.spriteTxIndexBufferLayout ||
      !this.pipelinePrimitiveState
    )
      return;
    const device = this.device;
    const format = getWebGPU().preferredFormat;
    const vertexState: GPUVertexState = {
      module: this.spriteShaderModule,
      entryPoint: "vs_main",
      buffers: [this.spriteVertexBufferLayout, this.spriteTxIndexBufferLayout],
    };
    const fragmentState: GPUFragmentState = {
      module: this.spriteShaderModule,
      entryPoint: "fs_main",
      targets: [
        {
          format,
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
    const msaa: GPUMultisampleState = { count: getMSAASampleCount() };
    const base = {
      layout: this.spritePipelineLayout,
      vertex: vertexState,
      fragment: fragmentState,
      primitive: this.pipelinePrimitiveState,
      multisample: msaa,
    };
    this.spritePipeline = device.createRenderPipeline({
      ...base,
      depthStencil: {
        format: DEPTH_FORMAT,
        depthCompare: "always",
        depthWriteEnabled: false,
      },
      label: "Sprite Pipeline",
    });
    this.spritePipelineDepth = device.createRenderPipeline({
      ...base,
      depthStencil: {
        format: DEPTH_FORMAT,
        depthCompare: "greater-equal",
        depthWriteEnabled: true,
      },
      label: "Sprite Pipeline (Depth)",
    });
    this.spritePipelineAlwaysWrite = device.createRenderPipeline({
      ...base,
      depthStencil: {
        format: DEPTH_FORMAT,
        depthCompare: "always",
        depthWriteEnabled: true,
      },
      label: "Sprite Pipeline (Always Write)",
    });
  }

  /**
   * Called when the user toggles MSAA on/off. Rebuilds MSAA-sensitive
   * textures and pipelines so the next frame matches the new sample count.
   * Safe to call between frames.
   */
  private rebuildForMSAA(): void {
    // Invalidate current render-pass state. The running frame's encoder (if
    // any) still references old attachments — we'll let it finish on the old
    // configuration. Next beginFrame will see the new textures.
    this.ensureMSTextures();
    this.rebuildShapeMSAAPipelines();
    this.rebuildSpriteMSAAPipelines();
    // Depth-resolve pipeline is only needed when MSAA is enabled. Force
    // recreation so it matches the current multisample state of the MSAA
    // depth view when that view changes from multisampled → 1x or vice versa.
    this.depthResolvePipeline = null;
    this.depthResolveBindGroupLayout = null;
  }

  /**
   * Set up MSAA color/depth textures and the off-mode depthCopyTexture to
   * match the current MSAA state.
   *
   * MSAA on:  mainColorTextureMS + mainDepthTextureMS exist; depthCopyTexture
   *           is unused (resolve pass writes mainDepthTexture directly).
   * MSAA off: MSAA textures are null; depthCopyTexture exists as a 1x
   *           copy-destination for copyDepthBuffer's copyTextureToTexture.
   */
  private ensureMSTextures(): void {
    if (!this.device || !this.mainColorTexture || !this.mainDepthTexture)
      return;
    const w = this.mainColorTexture.width;
    const h = this.mainColorTexture.height;
    const enabled = isMSAAEnabled();
    const sampleCount = getMSAASampleCount();

    if (enabled) {
      if (
        !this.mainColorTextureMS ||
        this.mainColorTextureMS.width !== w ||
        this.mainColorTextureMS.height !== h ||
        this.mainColorTextureMS.sampleCount !== sampleCount
      ) {
        this.mainColorTextureMS?.destroy();
        this.mainColorTextureMS = this.device.createTexture({
          size: { width: w, height: h },
          format: getWebGPU().preferredFormat,
          sampleCount,
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
          label: "Main Color Texture (MSAA)",
        });
        this.mainColorTextureMSView = this.mainColorTextureMS.createView({
          label: "Main Color Texture (MSAA) View",
        });
      }
      if (
        !this.mainDepthTextureMS ||
        this.mainDepthTextureMS.width !== w ||
        this.mainDepthTextureMS.height !== h ||
        this.mainDepthTextureMS.sampleCount !== sampleCount
      ) {
        this.mainDepthTextureMS?.destroy();
        this.mainDepthTextureMS = this.device.createTexture({
          size: { width: w, height: h },
          format: DEPTH_FORMAT,
          sampleCount,
          usage:
            GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
          label: "Main Depth Texture (MSAA)",
        });
        this.mainDepthTextureMSView = this.mainDepthTextureMS.createView({
          label: "Main Depth Texture (MSAA) View",
        });
      }
      if (this.depthCopyTexture) {
        this.depthCopyTexture.destroy();
        this.depthCopyTexture = null;
        this.depthCopyTextureView = null;
      }
    } else {
      if (this.mainColorTextureMS) {
        this.mainColorTextureMS.destroy();
        this.mainColorTextureMS = null;
        this.mainColorTextureMSView = null;
      }
      if (this.mainDepthTextureMS) {
        this.mainDepthTextureMS.destroy();
        this.mainDepthTextureMS = null;
        this.mainDepthTextureMSView = null;
      }
      if (
        !this.depthCopyTexture ||
        this.depthCopyTexture.width !== w ||
        this.depthCopyTexture.height !== h
      ) {
        this.depthCopyTexture?.destroy();
        this.depthCopyTexture = this.device.createTexture({
          size: { width: w, height: h },
          format: DEPTH_FORMAT,
          usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
          label: "Depth Copy Texture",
        });
        this.depthCopyTextureView = this.depthCopyTexture.createView({
          label: "Depth Copy Texture View",
        });
      }
    }
  }

  /** Resize the canvas to match the window size */
  resize(
    width: number,
    height: number,
    pixelRatio: number = window.devicePixelRatio,
  ): void {
    this.pixelRatio = pixelRatio;
    const w = Math.floor(width * pixelRatio);
    const h = Math.floor(height * pixelRatio);

    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
    }

    // Recreate 1x color/depth textures if canvas size changed. MSAA textures
    // are kept in sync via ensureMSTextures().
    if (
      this.device &&
      (!this.mainDepthTexture ||
        this.mainDepthTexture.width !== w ||
        this.mainDepthTexture.height !== h)
    ) {
      this.mainDepthTextureMS?.destroy();
      this.mainDepthTextureMS = null;
      this.mainDepthTextureMSView = null;
      this.mainDepthTexture?.destroy();
      this.depthCopyTexture?.destroy();
      this.depthCopyTexture = null;
      this.depthCopyTextureView = null;

      this.mainDepthTexture = this.device.createTexture({
        size: { width: w, height: h },
        format: DEPTH_FORMAT,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC,
        label: "Main Depth Texture",
      });
      this.mainDepthTextureView = this.mainDepthTexture.createView({
        label: "Main Depth Texture View",
      });
    }

    if (
      this.device &&
      (!this.mainColorTexture ||
        this.mainColorTexture.width !== w ||
        this.mainColorTexture.height !== h)
    ) {
      this.mainColorTextureMS?.destroy();
      this.mainColorTextureMS = null;
      this.mainColorTextureMSView = null;
      this.mainColorTexture?.destroy();

      this.mainColorTexture = this.device.createTexture({
        size: { width: w, height: h },
        format: getWebGPU().preferredFormat,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.TEXTURE_BINDING,
        label: "Main Color Texture",
      });
      this.mainColorTextureView = this.mainColorTexture.createView({
        label: "Main Color Texture View",
      });
    }

    this.ensureMSTextures();

    // Update view matrix to convert from pixel coords to clip space
    this.viewMatrix.identity();
    this.viewMatrix.scale(2 / width, 2 / height);
    this.viewMatrix.translate(-width / 2, -height / 2);
  }

  /** Get logical width in CSS pixels */
  getWidth(): number {
    return this.canvas.width / this.pixelRatio;
  }

  /** Get logical height in CSS pixels */
  getHeight(): number {
    return this.canvas.height / this.pixelRatio;
  }

  /** Get physical framebuffer width in device pixels. */
  getPhysicalWidth(): number {
    return this.canvas.width;
  }

  /** Get physical framebuffer height in device pixels. */
  getPhysicalHeight(): number {
    return this.canvas.height;
  }

  /** Get the device pixel ratio that the framebuffer is scaled by. */
  getPixelRatio(): number {
    return this.pixelRatio;
  }

  /** Get the current view matrix for custom render pipelines. */
  getViewMatrix(): Matrix3 {
    return this.viewMatrix;
  }

  /** Begin a new frame */
  beginFrame(): void {
    if (!this.device || !this.context) return;

    // Reset transform stack and z state
    this.transformStack.length = 0;
    this.currentTransform.identity();
    this.zStack.length = 0;
    this.currentZ = 0;
    this.currentZCoeffX = 0;
    this.currentZCoeffY = 0;
    this.currentZRowX = 0;
    this.currentZRowY = 0;
    this.currentZRowZ = 1;
    this.depthMode = "none";
    this.inOffscreenPass = false;

    // Reset per-frame transform buffer; slot 0 is the identity root.
    this.transformBuffer.reset();
    this.pendingTransformDirty = true;

    // Reset batches
    this.shapeBatch.resetBatch();
    this.shapeBatch.resetFrameOffsets();
    this.spriteBatch.vertexCount = 0;
    this.spriteBatch.indexCount = 0;
    this.spriteBatch.resetFrameOffsets();
    this.currentTexture = null;
    this.currentTextureBindGroup = null;

    // Reset stats
    this.drawCallCount = 0;
    this.triangleCount = 0;
    this.vertexCount = 0;

    // Create command encoder
    this.currentCommandEncoder = this.device.createCommandEncoder({
      label: "Frame Command Encoder",
    });

    // Save the swapchain texture for endFrame (used as fallback blit target
    // when copyColorBuffer is never called, and by copyColorBuffer itself).
    this.swapchainTexture = this.context.getCurrentTexture();
    this.colorCopied = false;

    // Scene renders to mainColorTextureMS when MSAA is on (auto-resolves to
    // mainColorTexture) or directly to mainColorTexture when MSAA is off.
    // The water filter (or endFrame fallback) produces the final swapchain.
    if (isMSAAEnabled()) {
      this.currentRenderTarget =
        this.mainColorTextureMSView ?? this.swapchainTexture.createView();
      this.currentResolveTarget = this.mainColorTextureView;
    } else {
      this.currentRenderTarget =
        this.mainColorTextureView ?? this.swapchainTexture.createView();
      this.currentResolveTarget = null;
    }
    const depthView = this.mainDepthTextureMSView ?? this.mainDepthTextureView;

    // Begin render pass with depth attachment
    this.currentRenderPass = this.currentCommandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.currentRenderTarget,
          resolveTarget: this.currentResolveTarget ?? undefined,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
      depthStencilAttachment: depthView
        ? {
            view: depthView,
            depthLoadOp: "clear",
            depthStoreOp: "store",
            depthClearValue: 0.0,
          }
        : undefined,
      timestampWrites: this.gpuProfiler?.getTimestampWrites(),
      label: "Main Render Pass",
    });
  }

  /** Get rendering stats from the last completed frame */
  getStats(): {
    drawCalls: number;
    triangles: number;
    vertices: number;
    textures: number;
    canvasWidth: number;
    canvasHeight: number;
    pixelRatio: number;
  } {
    return {
      drawCalls: this.lastDrawCallCount,
      triangles: this.lastTriangleCount,
      vertices: this.lastVertexCount,
      textures: this.textureManager.getTextureCount(),
      canvasWidth: this.canvas.width,
      canvasHeight: this.canvas.height,
      pixelRatio: this.pixelRatio,
    };
  }

  /** Get the number of draw calls in the current/last frame */
  getDrawCallCount(): number {
    return this.drawCallCount;
  }

  /** End frame and flush all batches */
  endFrame(): void {
    if (!this.device || !this.currentCommandEncoder || !this.currentRenderPass)
      return;

    // Flush any remaining batches
    this.flushShapes();
    this.flushSprites();

    // End render pass
    this.currentRenderPass.end();

    // Fallback: if no one called copyColorBuffer this frame, the scene is
    // still sitting in mainColorTexture and the swapchain is empty. Blit it
    // now. Happens in editor mode or any frame without SurfaceRenderer.
    if (
      !this.colorCopied &&
      this.mainColorTexture &&
      this.swapchainTexture &&
      this.mainColorTexture.width === this.swapchainTexture.width &&
      this.mainColorTexture.height === this.swapchainTexture.height
    ) {
      this.currentCommandEncoder.copyTextureToTexture(
        { texture: this.mainColorTexture },
        { texture: this.swapchainTexture },
        {
          width: this.mainColorTexture.width,
          height: this.mainColorTexture.height,
        },
      );
    }

    // Resolve GPU profiler timestamps before submit
    this.gpuProfiler?.resolve(this.currentCommandEncoder);

    // Submit command buffer
    this.device.queue.submit([this.currentCommandEncoder.finish()]);

    // Start async read of GPU profiler results
    this.gpuProfiler?.readResults();

    // Save stats for display
    this.lastDrawCallCount = this.drawCallCount;
    this.lastTriangleCount = this.triangleCount;
    this.lastVertexCount = this.vertexCount;

    // Clear current pass
    this.currentCommandEncoder = null;
    this.currentRenderPass = null;
    this.currentRenderTarget = null;
    this.swapchainTexture = null;
  }

  /** Flush all pending shape and sprite batches to ensure correct layer ordering before custom pipeline draws. */
  flush(): void {
    this.flushShapes();
    this.flushSprites();
  }

  /** Get the current render pass encoder for custom rendering */
  getCurrentRenderPass(): GPURenderPassEncoder | null {
    return this.currentRenderPass;
  }

  /**
   * End the current render pass and begin a new one, preserving framebuffer contents.
   * Use this to give a section of rendering its own render pass for GPU profiling
   * via timestamp queries. Returns the new render pass encoder.
   */
  restartRenderPass(
    timestampWrites?: GPURenderPassTimestampWrites,
    label?: string,
  ): GPURenderPassEncoder | null {
    if (
      !this.currentRenderPass ||
      !this.currentCommandEncoder ||
      !this.currentRenderTarget
    )
      return null;

    this.flush();
    this.currentRenderPass.end();

    this.currentRenderPass = this.currentCommandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.currentRenderTarget,
          resolveTarget: this.currentResolveTarget ?? undefined,
          loadOp: "load",
          storeOp: "store",
        },
      ],
      depthStencilAttachment:
        (this.mainDepthTextureMSView ?? this.mainDepthTextureView)
          ? {
              view: (this.mainDepthTextureMSView ?? this.mainDepthTextureView)!,
              depthLoadOp: "load",
              depthStoreOp: "store",
            }
          : undefined,
      timestampWrites,
      label,
    });

    return this.currentRenderPass;
  }

  /**
   * Switch rendering to an offscreen texture target.
   * Flushes pending batches and ends the current render pass before switching.
   * The offscreen target must use the same format as the canvas (preferredFormat).
   */
  beginOffscreenPass(target: GPUTextureView, clearColor?: GPUColor): void {
    if (!this.currentRenderPass || !this.currentCommandEncoder) return;

    this.flush();
    this.currentRenderPass.end();

    this.inOffscreenPass = true;
    this.currentRenderPass = this.currentCommandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: target,
          loadOp: "clear",
          storeOp: "store",
          clearValue: clearColor ?? { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
      label: "Offscreen Render Pass",
    });
  }

  /**
   * Resume rendering to the main framebuffer, preserving existing content.
   * Flushes pending batches and ends the current (offscreen) render pass.
   */
  resumeMainPass(): void {
    if (
      !this.currentRenderPass ||
      !this.currentCommandEncoder ||
      !this.currentRenderTarget
    )
      return;

    this.flush();
    this.currentRenderPass.end();
    this.inOffscreenPass = false;

    this.currentRenderPass = this.currentCommandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.currentRenderTarget,
          resolveTarget: this.currentResolveTarget ?? undefined,
          loadOp: "load",
          storeOp: "store",
        },
      ],
      depthStencilAttachment:
        (this.mainDepthTextureMSView ?? this.mainDepthTextureView)
          ? {
              view: (this.mainDepthTextureMSView ?? this.mainDepthTextureView)!,
              depthLoadOp: "load",
              depthStoreOp: "store",
            }
          : undefined,
      label: "Resumed Main Render Pass",
    });
  }

  /** Clear the screen with a color */
  clear(color: number = 0x000000, _alpha: number = 1.0): void {
    // In WebGPU, clearing is done via loadOp in beginRenderPass
    // For mid-frame clears, we would need to end and restart the pass
    // For now, we handle this by setting the clear color in beginFrame
    // This is a no-op since WebGPU handles clearing automatically
    void color;
  }

  // ============ Transform Stack ============

  /** Save the current transform and z state */
  save(): void {
    this.transformStack.push(this.currentTransform.clone());
    this.zStack.push([
      this.currentZ,
      this.currentZCoeffX,
      this.currentZCoeffY,
      this.currentZRowX,
      this.currentZRowY,
      this.currentZRowZ,
    ]);
  }

  /** Restore the previous transform and z state */
  restore(): void {
    const prev = this.transformStack.pop();
    if (prev) {
      this.currentTransform = prev;
    } else {
      this.warnOnce(
        "restore-stack-underflow",
        "WebGPURenderer.restore called with an empty transform stack; resetting to identity.",
      );
      this.currentTransform.identity();
    }
    const zPrev = this.zStack.pop();
    if (zPrev) {
      this.currentZ = zPrev[0];
      this.currentZCoeffX = zPrev[1];
      this.currentZCoeffY = zPrev[2];
      this.currentZRowX = zPrev[3];
      this.currentZRowY = zPrev[4];
      this.currentZRowZ = zPrev[5];
    } else {
      this.currentZ = 0;
      this.currentZCoeffX = 0;
      this.currentZCoeffY = 0;
      this.currentZRowX = 0;
      this.currentZRowY = 0;
      this.currentZRowZ = 1;
    }
    this.pendingTransformDirty = true;
  }

  /** Translate by (x, y) */
  translate(x: number, y: number): void;
  translate(pos: CompatibleVector): void;
  translate(xOrPos: number | CompatibleVector, y?: number): void {
    if (typeof xOrPos === "number") {
      this.currentTransform.translate(xOrPos, y!);
    } else {
      this.currentTransform.translate(xOrPos[0], xOrPos[1]);
    }
    this.pendingTransformDirty = true;
  }

  /** Rotate by angle (radians) */
  rotate(radians: number): void {
    this.currentTransform.rotate(radians);
    this.pendingTransformDirty = true;
  }

  /** Scale uniformly or non-uniformly */
  scale(s: number): void;
  scale(sx: number, sy: number): void;
  scale(sx: number, sy?: number): void {
    this.currentTransform.scale(sx, sy ?? sx);
    this.pendingTransformDirty = true;
  }

  /** Set a specific transform matrix */
  setTransform(matrix: Matrix3): void {
    this.currentTransform.copyFrom(matrix);
    this.pendingTransformDirty = true;
  }

  /** Get the current transform matrix */
  getTransform(): Matrix3 {
    return this.currentTransform.clone();
  }

  /** Gets the current scale factor (the larger of the two if they're not equal) */
  getCurrentScale(): number {
    // Use basis-vector lengths so rotation doesn't zero out the scale.
    // Matrix3 layout: x-basis = (a, b), y-basis = (c, d).
    const m = this.currentTransform;
    return Math.max(Math.hypot(m.a, m.b), Math.hypot(m.c, m.d));
  }

  // ============ Z-Height / Depth ============

  /** Set the z-height for subsequent draw calls. */
  setZ(z: number): void {
    this.currentZ = z;
    this.pendingTransformDirty = true;
  }

  /** Get the current z-height. */
  getZ(): number {
    return this.currentZ;
  }

  /** Set the z-to-position-offset coefficients (z-column of rotation: R[0,2], R[1,2]). */
  setZCoeffs(x: number, y: number): void {
    this.currentZCoeffX = x;
    this.currentZCoeffY = y;
    this.pendingTransformDirty = true;
  }

  /**
   * Set the z-row of the rotation matrix (R[2,0], R[2,1], R[2,2]).
   * Maps local vertex (x, y, z) → world z contribution for depth:
   *   worldZ = currentZ + zRowX·localX + zRowY·localY + zRowZ·localZ
   */
  setZRow(x: number, y: number, z: number): void {
    this.currentZRowX = x;
    this.currentZRowY = y;
    this.currentZRowZ = z;
    this.pendingTransformDirty = true;
  }

  /** Whether we're currently rendering to an offscreen pass (no depth attachment). */
  isInOffscreenPass(): boolean {
    return this.inOffscreenPass;
  }

  /**
   * Set the depth mode for subsequent draw calls.
   * Flushes pending batches when the mode changes (pipeline switch required).
   */
  setDepthMode(mode: "none" | "read-write" | "always-write"): void {
    if (this.depthMode !== mode) {
      this.flush();
      this.depthMode = mode;
    }
  }

  /**
   * Get a readable copy of the depth buffer (available after copyDepthBuffer
   * is called). MSAA: returns the resolved 1x depth that the resolve pass
   * wrote. No MSAA: returns depthCopyTexture which was populated via
   * copyTextureToTexture from the main depth texture.
   */
  getDepthCopyTextureView(): GPUTextureView | null {
    return isMSAAEnabled()
      ? this.mainDepthTextureView
      : this.depthCopyTextureView;
  }

  /** Get a readable copy of the scene color (available after copyColorBuffer is called). */
  getColorCopyTextureView(): GPUTextureView | null {
    return this.colorCopyTextureView;
  }

  /**
   * Resolve the MSAA depth buffer to a 1x texture readable by overlay shaders.
   * Must be called inside a render pass (ends it, runs a resolve pass, restarts).
   * Under MSAA, copyTextureToTexture from MSAA→1x is not allowed, so we use a
   * small fullscreen pass that samples the multisampled depth and writes the
   * nearest sample (min under reverse-Z) to a 1x depth attachment.
   */
  copyDepthBuffer(): void {
    if (
      !this.mainDepthTexture ||
      !this.mainDepthTextureView ||
      !this.currentCommandEncoder ||
      !this.currentRenderPass ||
      !this.currentRenderTarget
    )
      return;

    this.flush();
    this.currentRenderPass.end();

    if (isMSAAEnabled()) {
      // MSAA: resolve-pass samples multisampled depth and writes the nearest
      // sample into mainDepthTexture (1x) for overlay shaders to sample.
      const pipeline = this.getOrCreateDepthResolvePipeline();
      const bindGroup = this.device!.createBindGroup({
        layout: this.depthResolveBindGroupLayout!,
        entries: [{ binding: 0, resource: this.mainDepthTextureMSView! }],
        label: "Depth Resolve Bind Group",
      });

      const resolvePass = this.currentCommandEncoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: this.mainDepthTextureView,
          depthLoadOp: "clear",
          depthStoreOp: "store",
          depthClearValue: 0.0,
        },
        label: "Depth Resolve Pass",
      });
      resolvePass.setPipeline(pipeline);
      resolvePass.setBindGroup(0, bindGroup);
      resolvePass.draw(3);
      resolvePass.end();
    } else if (this.depthCopyTexture) {
      // No MSAA: copy mainDepthTexture → depthCopyTexture so the water filter
      // can sample it without colliding with the depth render attachment.
      this.currentCommandEncoder.copyTextureToTexture(
        { texture: this.mainDepthTexture },
        { texture: this.depthCopyTexture },
        {
          width: this.mainDepthTexture.width,
          height: this.mainDepthTexture.height,
        },
      );
    }

    // Restart main render pass (preserving framebuffer + depth).
    this.currentRenderPass = this.currentCommandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.currentRenderTarget,
          resolveTarget: this.currentResolveTarget ?? undefined,
          loadOp: "load",
          storeOp: "store",
        },
      ],
      depthStencilAttachment:
        (this.mainDepthTextureMSView ?? this.mainDepthTextureView)
          ? {
              view: (this.mainDepthTextureMSView ?? this.mainDepthTextureView)!,
              depthLoadOp: "load",
              depthStoreOp: "store",
            }
          : undefined,
      label: "Post-Depth-Resolve Render Pass",
    });
  }

  private getOrCreateDepthResolvePipeline(): GPURenderPipeline {
    if (this.depthResolvePipeline) return this.depthResolvePipeline;
    const device = this.device!;

    const shaderCode = /*wgsl*/ `
@group(0) @binding(0) var depthTex: texture_depth_multisampled_2d;

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
  // Fullscreen triangle covering clip space.
  let x = f32((idx << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(idx & 2u) * 2.0 - 1.0;
  return vec4<f32>(x, y, 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) pos: vec4<f32>) -> @builtin(frag_depth) f32 {
  let xy = vec2<i32>(pos.xy);
  // Reverse-Z: closer samples have larger depth. We want the nearest sample,
  // so take the max across all ${MSAA_SAMPLE_COUNT} samples.
  var d = textureLoad(depthTex, xy, 0);
  d = max(d, textureLoad(depthTex, xy, 1));
  d = max(d, textureLoad(depthTex, xy, 2));
  d = max(d, textureLoad(depthTex, xy, 3));
  return d;
}
`;

    const module = device.createShaderModule({
      code: shaderCode,
      label: "Depth Resolve Shader",
    });

    this.depthResolveBindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: {
            sampleType: "depth",
            viewDimension: "2d",
            multisampled: true,
          },
        },
      ],
      label: "Depth Resolve Bind Group Layout",
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.depthResolveBindGroupLayout],
      label: "Depth Resolve Pipeline Layout",
    });

    this.depthResolvePipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: "vs_main" },
      fragment: { module, entryPoint: "fs_main", targets: [] },
      primitive: { topology: "triangle-list" },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthCompare: "always",
        depthWriteEnabled: true,
      },
      label: "Depth Resolve Pipeline",
    });

    return this.depthResolvePipeline;
  }

  /**
   * Copy the mainColorTexture to colorCopyTexture and switch the active
   * render target to the swapchain. After this, subsequent draw calls go
   * directly to the swapchain, and shaders can sample the frozen scene
   * via getColorCopyTextureView(). Must be called inside a render pass.
   */
  copyColorBuffer(): void {
    if (
      !this.mainColorTexture ||
      !this.currentCommandEncoder ||
      !this.currentRenderPass ||
      !this.swapchainTexture
    )
      return;

    this.flush();
    this.currentRenderPass.end();

    // Lazy create/resize colorCopyTexture
    if (
      !this.colorCopyTexture ||
      this.colorCopyTexture.width !== this.mainColorTexture.width ||
      this.colorCopyTexture.height !== this.mainColorTexture.height
    ) {
      this.colorCopyTexture?.destroy();
      this.colorCopyTexture = this.device!.createTexture({
        size: {
          width: this.mainColorTexture.width,
          height: this.mainColorTexture.height,
        },
        format: getWebGPU().preferredFormat,
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
        label: "Color Copy Texture",
      });
      this.colorCopyTextureView = this.colorCopyTexture.createView({
        label: "Color Copy Texture View",
      });
    }

    this.currentCommandEncoder.copyTextureToTexture(
      { texture: this.mainColorTexture },
      { texture: this.colorCopyTexture },
      {
        width: this.mainColorTexture.width,
        height: this.mainColorTexture.height,
      },
    );

    // Switch render target so subsequent draws (water filter + post-water
    // particles) end up on the swapchain. MSAA: render into the MSAA color
    // texture and resolve to swapchain. No MSAA: render to swapchain directly.
    const swapchainView = this.swapchainTexture.createView({
      label: "Swapchain View",
    });
    if (isMSAAEnabled()) {
      this.currentRenderTarget = this.mainColorTextureMSView!;
      this.currentResolveTarget = swapchainView;
    } else {
      this.currentRenderTarget = swapchainView;
      this.currentResolveTarget = null;
    }
    this.colorCopied = true;

    this.currentRenderPass = this.currentCommandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.currentRenderTarget,
          resolveTarget: this.currentResolveTarget ?? undefined,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
      depthStencilAttachment:
        (this.mainDepthTextureMSView ?? this.mainDepthTextureView)
          ? {
              view: (this.mainDepthTextureMSView ?? this.mainDepthTextureView)!,
              depthLoadOp: "load",
              depthStoreOp: "store",
            }
          : undefined,
      label: "Post-Color-Copy Render Pass (Swapchain)",
    });
  }

  // ============ Transform allocation ============

  /**
   * Build a Transform struct from the current renderer state. Tint defaults
   * to white — future callers wanting per-instance tint will set it.
   */
  private buildPendingTransform(): Transform {
    const m = this.currentTransform;
    return {
      modelCol0X: m.a,
      modelCol0Y: m.b,
      modelCol1X: m.c,
      modelCol1Y: m.d,
      modelCol2X: m.tx,
      modelCol2Y: m.ty,
      zCoeffX: this.currentZCoeffX,
      zCoeffY: this.currentZCoeffY,
      zRowX: this.currentZRowX,
      zRowY: this.currentZRowY,
      zRowZ: this.currentZRowZ,
      zBase: this.currentZ,
      tintR: 1,
      tintG: 1,
      tintB: 1,
      tintA: 1,
    };
  }

  /**
   * Allocate a new transform-buffer slot if state has changed since the last
   * submit; otherwise reuse the previously-allocated slot. Both the shape and
   * sprite batches stamp this slot on newly reserved vertices.
   */
  private refreshTransformIndex(): void {
    if (!this.pendingTransformDirty) return;
    const idx = this.transformBuffer.alloc(this.buildPendingTransform());
    this.shapeBatch.currentTransformIndex = idx;
    this.spriteBatch.currentTransformIndex = idx;
    this.pendingTransformDirty = false;
  }

  // ============ Core Primitive ============

  /**
   * Submit triangles to the shape batch for rendering.
   */
  submitTriangles(
    vertices: [number, number][],
    indices: number[],
    color: number,
    alpha: number,
  ): void {
    this.submitTrianglesWithZ(vertices, indices, color, alpha, null);
  }

  /**
   * Submit triangles with optional per-vertex z-values for depth testing.
   * When zValues is null, uses the current global z from setZ().
   * When provided, each vertex gets its own z-height for accurate depth.
   */
  submitTrianglesWithZ(
    vertices: [number, number][],
    indices: number[],
    color: number,
    alpha: number,
    zValues: number[] | null,
  ): void {
    // Flush sprites before drawing shapes (maintains layer ordering)
    if (this.spriteBatch.indexCount > 0) {
      this.flushSprites();
    }

    // Flush if adding this call would overflow the shape batch.
    if (
      this.shapeBatch.vertexCount + vertices.length >
        this.shapeBatch.maxVertices ||
      this.shapeBatch.indexCount + indices.length > this.shapeBatch.maxIndices
    ) {
      this.flushShapes();
    }

    // Split oversize submissions into triangle-sized chunks.
    if (
      vertices.length > this.shapeBatch.maxVertices ||
      indices.length > this.shapeBatch.maxIndices
    ) {
      for (let t = 0; t < indices.length; t += 3) {
        const triIndices = indices.slice(t, t + 3);
        this.submitTrianglesWithZ(vertices, triIndices, color, alpha, zValues);
      }
      return;
    }

    this.refreshTransformIndex();

    const [r, g, b] = hexToVec3(color);
    const globalZ = this.currentZ;
    const { base, view } = this.shapeBatch.reserveVertices(vertices.length);

    for (let i = 0; i < vertices.length; i++) {
      const v = vertices[i];
      const z = zValues !== null ? zValues[i] : globalZ;
      const o = i * SHAPE_VERTEX_FLOATS;
      view[o] = v[0];
      view[o + 1] = v[1];
      view[o + 2] = r;
      view[o + 3] = g;
      view[o + 4] = b;
      view[o + 5] = alpha;
      view[o + 6] = z;
    }

    const idxSlice = this.shapeBatch.reserveIndices(indices.length);
    for (let i = 0; i < indices.length; i++) idxSlice[i] = base + indices[i];
  }

  /**
   * Submit triangles with per-vertex colors for smooth interpolation.
   * Same as submitTriangles but each vertex has its own RGBA color.
   * @param vertices - 2D vertex positions
   * @param indices - Triangle indices
   * @param colors - Per-vertex [r, g, b, a] colors (0-1 range), same length as vertices
   */
  submitColoredTriangles(
    vertices: [number, number][],
    indices: number[],
    colors: [number, number, number, number][],
  ): void {
    if (this.spriteBatch.indexCount > 0) {
      this.flushSprites();
    }

    if (
      this.shapeBatch.vertexCount + vertices.length >
        this.shapeBatch.maxVertices ||
      this.shapeBatch.indexCount + indices.length > this.shapeBatch.maxIndices
    ) {
      this.flushShapes();
    }

    if (
      vertices.length > this.shapeBatch.maxVertices ||
      indices.length > this.shapeBatch.maxIndices
    ) {
      for (let t = 0; t < indices.length; t += 3) {
        const triIndices = indices.slice(t, t + 3);
        this.submitColoredTriangles(vertices, triIndices, colors);
      }
      return;
    }

    this.refreshTransformIndex();

    const z = this.currentZ;
    const { base, view } = this.shapeBatch.reserveVertices(vertices.length);
    for (let i = 0; i < vertices.length; i++) {
      const v = vertices[i];
      const c = colors[i];
      const o = i * SHAPE_VERTEX_FLOATS;
      view[o] = v[0];
      view[o + 1] = v[1];
      view[o + 2] = c[0];
      view[o + 3] = c[1];
      view[o + 4] = c[2];
      view[o + 5] = c[3];
      view[o + 6] = z;
    }

    const idxSlice = this.shapeBatch.reserveIndices(indices.length);
    for (let i = 0; i < indices.length; i++) idxSlice[i] = base + indices[i];
  }

  /**
   * Submit a cached/dynamic mesh — the fast path. Memcpy-grade vertex + tx
   * upload, O(n) integer-add index rebase. One transform slot amortized
   * across the whole mesh.
   */
  drawMesh(m: CachedMesh | DynamicMesh): void {
    if (m.vertexCount === 0 || m.indexCount === 0) return;

    if (this.spriteBatch.indexCount > 0) this.flushSprites();

    // A mesh bigger than the batch can't be submitted in one shot. Splitting
    // is non-trivial (indices reference local vertices); drop with a warning.
    if (
      m.vertexCount > this.shapeBatch.maxVertices ||
      m.indexCount > this.shapeBatch.maxIndices
    ) {
      this.warnOnce(
        "drawMesh-oversize",
        `drawMesh skipped mesh with ${m.vertexCount} verts / ${m.indexCount} indices (exceeds batch capacity).`,
      );
      return;
    }

    if (
      this.shapeBatch.vertexCount + m.vertexCount >
        this.shapeBatch.maxVertices ||
      this.shapeBatch.indexCount + m.indexCount > this.shapeBatch.maxIndices
    ) {
      this.flushShapes();
    }

    this.refreshTransformIndex();

    const { base, view } = this.shapeBatch.reserveVertices(m.vertexCount);
    // Bulk memcpy the packed vertex stream.
    view.set(m.vertexData.subarray(0, m.vertexCount * SHAPE_VERTEX_FLOATS), 0);

    const idxSlice = this.shapeBatch.reserveIndices(m.indexCount);
    for (let i = 0; i < m.indexCount; i++) idxSlice[i] = base + m.indexData[i];
  }

  /** Flush the shape batch to the GPU */
  private flushShapes(): void {
    if (
      this.shapeBatch.indexCount === 0 ||
      !this.currentRenderPass ||
      !this.device
    )
      return;

    // Upload view matrix + the per-frame transform range (includes everything
    // allocated up through the slots this batch references).
    this.uploadUniforms(this.shapeUniformBuffer!);
    this.transformBuffer.upload(this.device);

    const pipeline = this.inOffscreenPass
      ? this.shapePipelineNoDepth!
      : this.depthMode === "read-write"
        ? this.shapePipelineDepth!
        : this.depthMode === "always-write"
          ? this.shapePipelineAlwaysWrite!
          : this.shapePipeline!;

    const { vertices, triangles } = this.shapeBatch.flush(
      this.device,
      this.currentRenderPass,
      pipeline,
      this.shapeBindGroup!,
    );
    if (vertices === 0) return;

    this.drawCallCount++;
    this.triangleCount += triangles;
    this.vertexCount += vertices;
  }

  // ============ Sprite Drawing ============

  /** Draw a textured image */
  drawImage(
    texture: WebGPUTexture,
    x: number,
    y: number,
    opts: SpriteOptions = {},
  ): void {
    if (this.shapeBatch.indexCount > 0) this.flushShapes();
    if (this.currentTexture && this.currentTexture !== texture) {
      this.flushSprites();
    }
    this.currentTexture = texture;
    this.currentTextureBindGroup = this.getTextureBindGroup(texture);

    const rotation = opts.rotation ?? 0;
    const scaleX = opts.scaleX ?? 1;
    const scaleY = opts.scaleY ?? 1;
    const alpha = opts.alpha ?? 1;
    const tint = opts.tint ?? 0xffffff;
    const anchorX = opts.anchorX ?? 0.5;
    const anchorY = opts.anchorY ?? 0.5;

    const tw = texture.width;
    const th = texture.height;

    // Build combined transform (anchor + scale + rotate + translate, then
    // composed with the current world transform). We allocate a dedicated
    // instance-transform slot for this quad so it can be positioned
    // independently without disturbing the caller's transform state.
    const m = this.spriteMatrix;
    m.identity();
    m.translate(x, y);
    m.rotate(rotation);
    m.scale(scaleX, scaleY);
    m.translate(-anchorX * tw, -anchorY * th);
    m.premultiply(this.currentTransform);

    const tr = ((tint >> 16) & 0xff) / 255;
    const tg = ((tint >> 8) & 0xff) / 255;
    const tb = (tint & 0xff) / 255;

    // Flush if adding the quad would overflow.
    if (
      this.spriteBatch.vertexCount + 4 > this.spriteBatch.maxVertices ||
      this.spriteBatch.indexCount + 6 > this.spriteBatch.maxIndices
    ) {
      this.flushSprites();
    }

    // Allocate a one-off transform slot that carries the sprite's local
    // matrix and the current z-state. Identity-tint (no per-sprite tint
    // coloring here — tint is applied to the vertex color RGB).
    const slot = this.transformBuffer.alloc({
      modelCol0X: m.a,
      modelCol0Y: m.b,
      modelCol1X: m.c,
      modelCol1Y: m.d,
      modelCol2X: m.tx,
      modelCol2Y: m.ty,
      zCoeffX: this.currentZCoeffX,
      zCoeffY: this.currentZCoeffY,
      zRowX: this.currentZRowX,
      zRowY: this.currentZRowY,
      zRowZ: this.currentZRowZ,
      zBase: this.currentZ,
      tintR: 1,
      tintG: 1,
      tintB: 1,
      tintA: 1,
    });
    this.spriteBatch.currentTransformIndex = slot;

    this.spriteBatch.writeQuad(
      [
        [0, 0],
        [tw, 0],
        [tw, th],
        [0, th],
      ],
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
      tr,
      tg,
      tb,
      alpha,
      this.currentZ,
    );
  }

  /** Get or create a bind group for a texture */
  private getTextureBindGroup(texture: WebGPUTexture): GPUBindGroup {
    let bindGroup = this.textureBindGroupCache.get(texture);
    if (!bindGroup) {
      bindGroup = this.device!.createBindGroup({
        layout: this.spriteTextureBindGroupLayout!,
        entries: [
          {
            binding: 0,
            resource: texture.view,
          },
        ],
        label: "Sprite Texture Bind Group",
      });
      this.textureBindGroupCache.set(texture, bindGroup);
    }
    return bindGroup;
  }

  /** Flush the sprite batch to the GPU */
  private flushSprites(): void {
    if (
      this.spriteBatch.indexCount === 0 ||
      !this.currentTexture ||
      !this.currentRenderPass ||
      !this.device
    )
      return;

    this.uploadUniforms(this.spriteUniformBuffer!);
    this.transformBuffer.upload(this.device);

    const pipeline = this.inOffscreenPass
      ? this.spritePipelineNoDepth!
      : this.depthMode === "read-write"
        ? this.spritePipelineDepth!
        : this.depthMode === "always-write"
          ? this.spritePipelineAlwaysWrite!
          : this.spritePipeline!;

    const { vertices, triangles } = this.spriteBatch.flush(
      this.device,
      this.currentRenderPass,
      pipeline,
      this.spriteUniformBindGroup!,
      this.currentTextureBindGroup!,
    );
    if (vertices === 0) return;

    this.drawCallCount++;
    this.triangleCount += triangles;
    this.vertexCount += vertices;
  }

  /** Upload uniforms (view matrix only — depth transform is per-vertex) */
  private uploadUniforms(buffer: GPUBuffer): void {
    if (!this.device) return;

    this.viewUniforms.set.viewMatrix(this.viewMatrix);
    this.viewUniforms.uploadTo(buffer);
  }

  // ============ Texture Generation ============

  /** Generate a texture from draw commands */
  generateTexture(
    draw: (renderer: WebGPURenderer) => void,
    width: number,
    height: number,
  ): WebGPUTexture {
    // Create render target texture
    const texture = this.textureManager.createRenderTarget(
      width,
      height,
      getWebGPU().preferredFormat,
      "Generated Texture",
    );

    // Save current state
    const oldWidth = this.getWidth();
    const oldHeight = this.getHeight();
    const oldViewMatrix = this.viewMatrix.clone();
    const oldTransform = this.currentTransform.clone();

    // Set up for texture rendering
    this.viewMatrix.identity();
    this.viewMatrix.scale(2 / width, 2 / height);
    this.viewMatrix.translate(-width / 2, -height / 2);
    this.currentTransform.identity();

    // Create separate command encoder for texture generation
    const commandEncoder = this.device!.createCommandEncoder({
      label: "Generate Texture Command Encoder",
    });

    // Save current render pass state
    const savedPass = this.currentRenderPass;
    const savedEncoder = this.currentCommandEncoder;
    const savedOffscreen = this.inOffscreenPass;

    // Begin render pass to texture (no depth attachment)
    this.currentCommandEncoder = commandEncoder;
    this.inOffscreenPass = true;
    this.currentRenderPass = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: texture.view,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
      label: "Generate Texture Render Pass",
    });

    // Draw
    draw(this);

    // Flush and end
    this.flushShapes();
    this.flushSprites();
    this.currentRenderPass.end();

    // Submit
    this.device!.queue.submit([commandEncoder.finish()]);

    // Restore state
    this.currentRenderPass = savedPass;
    this.currentCommandEncoder = savedEncoder;
    this.inOffscreenPass = savedOffscreen;
    this.resize(oldWidth, oldHeight, this.pixelRatio);
    this.viewMatrix = oldViewMatrix;
    this.currentTransform = oldTransform;

    return texture;
  }

  // ============ GPU Timing ============

  /** Check if GPU timing (timestamp queries) is supported */
  hasGpuTimerSupport(): boolean {
    return this.gpuProfiler !== null;
  }

  /** Enable/disable GPU timing */
  setGpuTimingEnabled(enabled: boolean): void {
    this.gpuProfiler?.setEnabled(enabled);
  }

  /** Check if GPU timing is currently enabled */
  isGpuTimingEnabled(): boolean {
    return this.gpuProfiler?.isEnabled() ?? false;
  }

  /** Get GPU time in milliseconds for a specific section (default: render) */
  getGpuMs(section?: GPUProfileSection): number {
    return this.gpuProfiler?.getMs(section) ?? 0;
  }

  /** Get all GPU section timings */
  getAllGpuMs(): Record<GPUProfileSection, number> | null {
    return this.gpuProfiler?.getAllMs() ?? null;
  }

  /** Get the GPU profiler instance (for external systems like water compute) */
  getGpuProfiler(): GPUProfiler | null {
    return this.gpuProfiler;
  }

  /** Clean up all resources */
  destroy(): void {
    this.unsubscribeMSAA?.();
    this.unsubscribeMSAA = null;
    this.textureManager.destroy();
    this.textureBindGroupCache.clear();

    this.shapeBatch.dispose();
    this.spriteBatch.dispose();
    this.transformBuffer.dispose();

    this.shapeUniformBuffer?.destroy();
    this.spriteUniformBuffer?.destroy();

    this.mainDepthTexture?.destroy();
    this.mainDepthTextureMS?.destroy();
    this.depthCopyTexture?.destroy();
    this.mainColorTexture?.destroy();
    this.mainColorTextureMS?.destroy();
    this.colorCopyTexture?.destroy();

    this.initialized = false;
  }
}
