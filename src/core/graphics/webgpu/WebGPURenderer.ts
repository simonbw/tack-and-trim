/**
 * Immediate-mode 2D WebGPU renderer.
 * All draw calls are batched and flushed at frame end or on state change.
 *
 * Architecture:
 * - Two batch types: shapes (untextured) and sprites (textured)
 * - Transform stack with Matrix3
 * - Batched rendering with automatic flushing
 */

import { hexToVec3 } from "../../util/ColorUtils";
import { CompatibleVector } from "../../Vector";
import { Matrix3 } from "../Matrix3";
import {
  defineUniformStruct,
  mat3x3,
  type UniformInstance,
} from "../UniformStruct";
import { GPUProfiler, GPUProfileSection } from "./GPUProfiler";
import { getWebGPU } from "./WebGPUDevice";
import { WebGPUTexture, WebGPUTextureManager } from "./WebGPUTextureManager";

// Shape shader: Renders untextured colored primitives
const shapeShaderSource = /*wgsl*/ `
struct Uniforms {
  viewMatrix: mat3x3<f32>,
}

struct VertexInput {
  @location(0) position: vec2<f32>,
  @location(1) color: vec4<f32>,
  @location(2) modelCol0: vec2<f32>,
  @location(3) modelCol1: vec2<f32>,
  @location(4) modelCol2: vec2<f32>,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
  let modelMatrix = mat3x3<f32>(
    vec3<f32>(in.modelCol0.x, in.modelCol0.y, 0.0),
    vec3<f32>(in.modelCol1.x, in.modelCol1.y, 0.0),
    vec3<f32>(in.modelCol2.x, in.modelCol2.y, 1.0)
  );
  let worldPos = modelMatrix * vec3<f32>(in.position, 1.0);
  let clipPos = uniforms.viewMatrix * worldPos;

  var out: VertexOutput;
  out.position = vec4<f32>(clipPos.xy, 0.0, 1.0);
  out.color = in.color;
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  return in.color;
}
`;

// Sprite shader: Renders textured quads with tinting
const spriteShaderSource = /*wgsl*/ `
struct Uniforms {
  viewMatrix: mat3x3<f32>,
}

struct VertexInput {
  @location(0) position: vec2<f32>,
  @location(1) texCoord: vec2<f32>,
  @location(2) color: vec4<f32>,
  @location(3) modelCol0: vec2<f32>,
  @location(4) modelCol1: vec2<f32>,
  @location(5) modelCol2: vec2<f32>,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) texCoord: vec2<f32>,
  @location(1) color: vec4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var textureSampler: sampler;
@group(1) @binding(0) var spriteTexture: texture_2d<f32>;

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
  let modelMatrix = mat3x3<f32>(
    vec3<f32>(in.modelCol0.x, in.modelCol0.y, 0.0),
    vec3<f32>(in.modelCol1.x, in.modelCol1.y, 0.0),
    vec3<f32>(in.modelCol2.x, in.modelCol2.y, 1.0)
  );
  let worldPos = modelMatrix * vec3<f32>(in.position, 1.0);
  let clipPos = uniforms.viewMatrix * worldPos;

  var out: VertexOutput;
  out.position = vec4<f32>(clipPos.xy, 0.0, 1.0);
  out.texCoord = in.texCoord;
  out.color = in.color;
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

// Batch vertex size includes per-vertex model matrix (6 floats: a, b, c, d, tx, ty)
const SPRITE_VERTEX_SIZE = 14; // position (2) + texCoord (2) + color (4) + matrix (6)
const SHAPE_VERTEX_SIZE = 12; // position (2) + color (4) + matrix (6)
const MAX_BATCH_VERTICES = 65536;
const MAX_BATCH_INDICES = MAX_BATCH_VERTICES * 6;

// Type-safe uniform buffer definition
const ViewUniforms = defineUniformStruct("Uniforms", {
  viewMatrix: mat3x3,
});

const UNIFORM_BUFFER_SIZE = ViewUniforms.byteSize;

/**
 * Immediate-mode 2D WebGPU renderer.
 */
export class WebGPURenderer {
  readonly canvas: HTMLCanvasElement;
  readonly textureManager: WebGPUTextureManager;

  private context: GPUCanvasContext | null = null;
  private device: GPUDevice | null = null;

  // Pipelines
  private shapePipeline: GPURenderPipeline | null = null;
  private spritePipeline: GPURenderPipeline | null = null;

  // Shape batch resources
  private shapeVertices: Float32Array;
  private shapeIndices: Uint16Array;
  private shapeVertexBuffer: GPUBuffer | null = null;
  private shapeIndexBuffer: GPUBuffer | null = null;
  private shapeUniformBuffer: GPUBuffer | null = null;
  private shapeBindGroup: GPUBindGroup | null = null;
  private shapeVertexCount = 0;
  private shapeIndexCount = 0;

  // Sprite batch resources
  private spriteVertices: Float32Array;
  private spriteIndices: Uint16Array;
  private spriteVertexBuffer: GPUBuffer | null = null;
  private spriteIndexBuffer: GPUBuffer | null = null;
  private spriteUniformBuffer: GPUBuffer | null = null;
  private spriteBindGroupLayout: GPUBindGroupLayout | null = null;
  private spriteTextureBindGroupLayout: GPUBindGroupLayout | null = null;
  private spriteUniformBindGroup: GPUBindGroup | null = null;
  private spriteVertexCount = 0;
  private spriteIndexCount = 0;
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

  // Track initialization state
  private initialized = false;

  // GPU profiler (null if timestamp queries not supported)
  private gpuProfiler: GPUProfiler | null = null;

  constructor(canvas?: HTMLCanvasElement) {
    this.canvas = canvas ?? document.createElement("canvas");
    this.textureManager = new WebGPUTextureManager();

    // Pre-allocate batch buffers
    this.shapeVertices = new Float32Array(
      MAX_BATCH_VERTICES * SHAPE_VERTEX_SIZE,
    );
    this.shapeIndices = new Uint16Array(MAX_BATCH_INDICES);
    this.spriteVertices = new Float32Array(
      MAX_BATCH_VERTICES * SPRITE_VERTEX_SIZE,
    );
    this.spriteIndices = new Uint16Array(MAX_BATCH_INDICES);
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

    this.initialized = true;
  }

  private async createShapePipeline(): Promise<void> {
    if (!this.device) return;

    const device = this.device;

    // Create shader module
    const shaderModule = device.createShaderModule({
      code: shapeShaderSource,
      label: "Shape Shader",
    });

    // Create uniform buffer
    this.shapeUniformBuffer = device.createBuffer({
      size: UNIFORM_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Shape Uniform Buffer",
    });

    // Create bind group layout
    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "uniform" },
        },
      ],
      label: "Shape Bind Group Layout",
    });

    // Create bind group
    this.shapeBindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.shapeUniformBuffer },
        },
      ],
      label: "Shape Bind Group",
    });

    // Create pipeline layout
    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
      label: "Shape Pipeline Layout",
    });

    // Create vertex buffer layout
    const vertexBufferLayout: GPUVertexBufferLayout = {
      arrayStride: SHAPE_VERTEX_SIZE * 4, // 48 bytes
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x2" }, // position
        { shaderLocation: 1, offset: 8, format: "float32x4" }, // color
        { shaderLocation: 2, offset: 24, format: "float32x2" }, // modelCol0
        { shaderLocation: 3, offset: 32, format: "float32x2" }, // modelCol1
        { shaderLocation: 4, offset: 40, format: "float32x2" }, // modelCol2
      ],
    };

    // Create pipeline
    this.shapePipeline = device.createRenderPipeline({
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
      },
      primitive: {
        topology: "triangle-list",
      },
      label: "Shape Pipeline",
    });

    // Create vertex and index buffers
    this.shapeVertexBuffer = device.createBuffer({
      size: this.shapeVertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      label: "Shape Vertex Buffer",
    });

    this.shapeIndexBuffer = device.createBuffer({
      size: this.shapeIndices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      label: "Shape Index Buffer",
    });
  }

  private async createSpritePipeline(): Promise<void> {
    if (!this.device) return;

    const device = this.device;

    // Create shader module
    const shaderModule = device.createShaderModule({
      code: spriteShaderSource,
      label: "Sprite Shader",
    });

    // Create uniform buffer
    this.spriteUniformBuffer = device.createBuffer({
      size: UNIFORM_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Sprite Uniform Buffer",
    });

    // Create bind group layout for uniforms and sampler (group 0)
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

    // Create uniform/sampler bind group
    this.spriteUniformBindGroup = device.createBindGroup({
      layout: this.spriteBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.spriteUniformBuffer },
        },
        {
          binding: 1,
          resource: this.defaultSampler!,
        },
      ],
      label: "Sprite Uniform Bind Group",
    });

    // Create pipeline layout
    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [
        this.spriteBindGroupLayout,
        this.spriteTextureBindGroupLayout,
      ],
      label: "Sprite Pipeline Layout",
    });

    // Create vertex buffer layout
    const vertexBufferLayout: GPUVertexBufferLayout = {
      arrayStride: SPRITE_VERTEX_SIZE * 4, // 56 bytes
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x2" }, // position
        { shaderLocation: 1, offset: 8, format: "float32x2" }, // texCoord
        { shaderLocation: 2, offset: 16, format: "float32x4" }, // color
        { shaderLocation: 3, offset: 32, format: "float32x2" }, // modelCol0
        { shaderLocation: 4, offset: 40, format: "float32x2" }, // modelCol1
        { shaderLocation: 5, offset: 48, format: "float32x2" }, // modelCol2
      ],
    };

    // Create pipeline
    this.spritePipeline = device.createRenderPipeline({
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
      },
      primitive: {
        topology: "triangle-list",
      },
      label: "Sprite Pipeline",
    });

    // Create vertex and index buffers
    this.spriteVertexBuffer = device.createBuffer({
      size: this.spriteVertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      label: "Sprite Vertex Buffer",
    });

    this.spriteIndexBuffer = device.createBuffer({
      size: this.spriteIndices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      label: "Sprite Index Buffer",
    });

    // Initialize GPU profiler if timestamp queries are supported
    const gpuManager = getWebGPU();
    if (gpuManager.features.timestampQuery) {
      this.gpuProfiler = new GPUProfiler(device);
      this.gpuProfiler.setEnabled(true);
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

  /** Begin a new frame */
  beginFrame(): void {
    if (!this.device || !this.context) return;

    // Reset transform stack
    this.transformStack.length = 0;
    this.currentTransform.identity();

    // Reset batches
    this.shapeVertexCount = 0;
    this.shapeIndexCount = 0;
    this.spriteVertexCount = 0;
    this.spriteIndexCount = 0;
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

    // Get current texture view
    this.currentRenderTarget = this.context.getCurrentTexture().createView();

    // Begin render pass
    this.currentRenderPass = this.currentCommandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.currentRenderTarget,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
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
  }

  /** Get the current render pass encoder for custom rendering */
  getCurrentRenderPass(): GPURenderPassEncoder | null {
    return this.currentRenderPass;
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

  /** Save the current transform */
  save(): void {
    this.transformStack.push(this.currentTransform.clone());
  }

  /** Restore the previous transform */
  restore(): void {
    const prev = this.transformStack.pop();
    if (prev) {
      this.currentTransform = prev;
    } else {
      this.currentTransform.identity();
    }
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
  }

  /** Rotate by angle (radians) */
  rotate(radians: number): void {
    this.currentTransform.rotate(radians);
  }

  /** Scale uniformly or non-uniformly */
  scale(s: number): void;
  scale(sx: number, sy: number): void;
  scale(sx: number, sy?: number): void {
    this.currentTransform.scale(sx, sy ?? sx);
  }

  /** Set a specific transform matrix */
  setTransform(matrix: Matrix3): void {
    this.currentTransform.copyFrom(matrix);
  }

  /** Get the current transform matrix */
  getTransform(): Matrix3 {
    return this.currentTransform.clone();
  }

  /** Gets the current scale factor (the larger of the two if they're not equal) */
  getCurrentScale(): number {
    // Return the maximum scale from the matrix (a = scaleX, d = scaleY)
    return Math.max(
      Math.abs(this.currentTransform.a),
      Math.abs(this.currentTransform.d),
    );
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
    // Flush sprites before drawing shapes (maintains layer ordering)
    if (this.spriteIndexCount > 0) {
      this.flushSprites();
    }

    // Check if we need to flush
    if (
      this.shapeVertexCount + vertices.length > MAX_BATCH_VERTICES ||
      this.shapeIndexCount + indices.length > MAX_BATCH_INDICES
    ) {
      this.flushShapes();
    }

    // Extract color components
    const [r, g, b] = hexToVec3(color);

    // Extract model matrix components
    const m = this.currentTransform;
    const ma = m.a,
      mb = m.b,
      mc = m.c,
      md = m.d,
      mtx = m.tx,
      mty = m.ty;

    const baseVertex = this.shapeVertexCount;

    // Store untransformed vertices with per-vertex color and model matrix
    for (const v of vertices) {
      const offset = this.shapeVertexCount * SHAPE_VERTEX_SIZE;
      this.shapeVertices.set(
        [v[0], v[1], r, g, b, alpha, ma, mb, mc, md, mtx, mty],
        offset,
      );
      this.shapeVertexCount++;
    }

    // Add indices
    for (const idx of indices) {
      this.shapeIndices[this.shapeIndexCount++] = baseVertex + idx;
    }
  }

  /** Flush the shape batch to the GPU */
  private flushShapes(): void {
    if (this.shapeIndexCount === 0 || !this.currentRenderPass || !this.device)
      return;

    this.drawCallCount++;
    this.triangleCount += this.shapeIndexCount / 3;
    this.vertexCount += this.shapeVertexCount;

    // Upload view matrix to uniform buffer
    this.uploadViewMatrix(this.shapeUniformBuffer!);

    // Upload vertex data
    const vertexData = this.shapeVertices.subarray(
      0,
      this.shapeVertexCount * SHAPE_VERTEX_SIZE,
    );
    this.device.queue.writeBuffer(
      this.shapeVertexBuffer!,
      0,
      vertexData.buffer,
      vertexData.byteOffset,
      vertexData.byteLength,
    );

    // Upload index data
    // WebGPU requires writeBuffer size to be a multiple of 4 bytes.
    // Uint16 indices may have odd count, so round up to even count.
    const paddedIndexCount = (this.shapeIndexCount + 1) & ~1;
    const indexData = this.shapeIndices.subarray(0, paddedIndexCount);
    this.device.queue.writeBuffer(
      this.shapeIndexBuffer!,
      0,
      indexData.buffer,
      indexData.byteOffset,
      indexData.byteLength,
    );

    // Draw
    this.currentRenderPass.setPipeline(this.shapePipeline!);
    this.currentRenderPass.setBindGroup(0, this.shapeBindGroup!);
    this.currentRenderPass.setVertexBuffer(0, this.shapeVertexBuffer!);
    this.currentRenderPass.setIndexBuffer(this.shapeIndexBuffer!, "uint16");
    this.currentRenderPass.drawIndexed(this.shapeIndexCount);

    // Reset batch
    this.shapeVertexCount = 0;
    this.shapeIndexCount = 0;
  }

  // ============ Sprite Drawing ============

  /** Draw a textured image */
  drawImage(
    texture: WebGPUTexture,
    x: number,
    y: number,
    opts: SpriteOptions = {},
  ): void {
    // Flush shapes before drawing sprites
    if (this.shapeIndexCount > 0) {
      this.flushShapes();
    }

    // Flush if texture changes
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

    // Build combined transform matrix
    const m = this.spriteMatrix;
    m.identity();
    m.translate(x, y);
    m.rotate(rotation);
    m.scale(scaleX, scaleY);
    m.translate(-anchorX * tw, -anchorY * th);
    m.premultiply(this.currentTransform);

    // Extract matrix values for per-vertex storage
    const ma = m.a,
      mb = m.b,
      mc = m.c,
      md = m.d,
      mtx = m.tx,
      mty = m.ty;

    const tr = ((tint >> 16) & 0xff) / 255;
    const tg = ((tint >> 8) & 0xff) / 255;
    const tb = (tint & 0xff) / 255;

    // Corners and UVs
    const corners = [
      [0, 0],
      [tw, 0],
      [tw, th],
      [0, th],
    ];
    const uvs = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];

    // Check if we need to flush
    if (
      this.spriteVertexCount + 4 > MAX_BATCH_VERTICES ||
      this.spriteIndexCount + 6 > MAX_BATCH_INDICES
    ) {
      this.flushSprites();
    }

    const baseVertex = this.spriteVertexCount / SPRITE_VERTEX_SIZE;

    for (let i = 0; i < 4; i++) {
      const offset = this.spriteVertexCount;
      this.spriteVertices.set(
        [
          corners[i][0],
          corners[i][1],
          uvs[i][0],
          uvs[i][1],
          tr,
          tg,
          tb,
          alpha,
          ma,
          mb,
          mc,
          md,
          mtx,
          mty,
        ],
        offset,
      );
      this.spriteVertexCount += SPRITE_VERTEX_SIZE;
    }

    // Add indices (two triangles)
    this.spriteIndices[this.spriteIndexCount++] = baseVertex;
    this.spriteIndices[this.spriteIndexCount++] = baseVertex + 1;
    this.spriteIndices[this.spriteIndexCount++] = baseVertex + 2;
    this.spriteIndices[this.spriteIndexCount++] = baseVertex;
    this.spriteIndices[this.spriteIndexCount++] = baseVertex + 2;
    this.spriteIndices[this.spriteIndexCount++] = baseVertex + 3;
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
      this.spriteIndexCount === 0 ||
      !this.currentTexture ||
      !this.currentRenderPass ||
      !this.device
    )
      return;

    this.drawCallCount++;
    this.triangleCount += this.spriteIndexCount / 3;
    this.vertexCount += this.spriteVertexCount / SPRITE_VERTEX_SIZE;

    // Upload view matrix to uniform buffer
    this.uploadViewMatrix(this.spriteUniformBuffer!);

    // Upload vertex data
    const spriteVertexData = this.spriteVertices.subarray(
      0,
      this.spriteVertexCount,
    );
    this.device.queue.writeBuffer(
      this.spriteVertexBuffer!,
      0,
      spriteVertexData.buffer,
      spriteVertexData.byteOffset,
      spriteVertexData.byteLength,
    );

    // Upload index data
    // WebGPU requires writeBuffer size to be a multiple of 4 bytes.
    // Uint16 indices may have odd count, so round up to even count.
    const paddedSpriteIndexCount = (this.spriteIndexCount + 1) & ~1;
    const spriteIndexData = this.spriteIndices.subarray(
      0,
      paddedSpriteIndexCount,
    );
    this.device.queue.writeBuffer(
      this.spriteIndexBuffer!,
      0,
      spriteIndexData.buffer,
      spriteIndexData.byteOffset,
      spriteIndexData.byteLength,
    );

    // Draw
    this.currentRenderPass.setPipeline(this.spritePipeline!);
    this.currentRenderPass.setBindGroup(0, this.spriteUniformBindGroup!);
    this.currentRenderPass.setBindGroup(1, this.currentTextureBindGroup!);
    this.currentRenderPass.setVertexBuffer(0, this.spriteVertexBuffer!);
    this.currentRenderPass.setIndexBuffer(this.spriteIndexBuffer!, "uint16");
    this.currentRenderPass.drawIndexed(this.spriteIndexCount);

    // Reset batch
    this.spriteVertexCount = 0;
    this.spriteIndexCount = 0;
  }

  /** Upload view matrix to a uniform buffer */
  private uploadViewMatrix(buffer: GPUBuffer): void {
    if (!this.device) return;

    // Use type-safe setter which handles mat3x3 padding automatically
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

    // Begin render pass to texture
    this.currentCommandEncoder = commandEncoder;
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
    this.textureManager.destroy();
    this.textureBindGroupCache.clear();

    this.shapeVertexBuffer?.destroy();
    this.shapeIndexBuffer?.destroy();
    this.shapeUniformBuffer?.destroy();

    this.spriteVertexBuffer?.destroy();
    this.spriteIndexBuffer?.destroy();
    this.spriteUniformBuffer?.destroy();

    this.initialized = false;
  }
}
