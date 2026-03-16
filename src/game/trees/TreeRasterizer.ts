/**
 * GPU instanced tree renderer using polygon mesh geometry.
 *
 * Renders trees as triangle-fan polygons with depth buffering.
 * Each tree is a vec4(x, y, phase, 0) in a storage buffer.
 * Vertex shader generates N-gon geometry matching each whorl's bumpy
 * branch-tip shape. Depth buffer handles inter-tree layer interleaving.
 * Fragment shader just outputs interpolated vertex color (fully opaque).
 *
 * 6 layers per tree: whorls 0–4 (bottom to top) + leader tip.
 * Each layer is a triangle fan with edgeCount triangles.
 * Single draw call: draw(verticesPerTree, treeCount).
 *
 * Zoom-adaptive LOD varies edge count (all layers always rendered
 * to preserve color composition):
 *   < 0.3x:  6 edges →  108 verts/tree
 *   0.3–1x:  8 edges →  144 verts/tree
 *   1–3x:   16 edges →  288 verts/tree
 *   3–7x:   32 edges →  576 verts/tree
 *   7–14x:  48 edges →  864 verts/tree
 *   > 14x:  64 edges → 1152 verts/tree
 */

import {
  defineUniformStruct,
  f32,
  type UniformInstance,
} from "../../core/graphics/UniformStruct";
import { getWebGPU } from "../../core/graphics/webgpu/WebGPUDevice";
import type { GPUProfiler } from "../../core/graphics/webgpu/GPUProfiler";
import { fn_simplex3D } from "../world/shaders/noise.wgsl";
import { fn_calculateWindVelocity } from "../world/shaders/wind.wgsl";
import {
  WIND_NOISE_SPATIAL_SCALE,
  WIND_NOISE_TIME_SCALE,
  WIND_SPEED_VARIATION,
  WIND_ANGLE_VARIATION,
  WIND_FLOW_CYCLE_PERIOD,
  WIND_SLOW_TIME_SCALE,
} from "../world/wind/WindConstants";

// Quad half-extent in world feet. Must be large enough for the biggest tree
// (outer whorl ~0.64 UV * sizeVar 1.35 + bumps ≈ 0.95 UV → 0.95 * 18 = 17.1 ft).
const QUAD_HALF = 18;

// Offscreen texture format for tree rendering
const OFFSCREEN_FORMAT: GPUTextureFormat = "rgba8unorm";

// Depth texture format
const DEPTH_FORMAT: GPUTextureFormat = "depth24plus";

// Always render all 6 layers (5 whorls + leader) — dropping layers causes
// visible color shifts across the whole screen. Only vary edge count.
const NUM_LAYERS = 6;

// Edge counts by zoom level
const EDGE_COUNTS = [6, 8, 16, 32, 48, 64];

const TreeUniforms = defineUniformStruct("TreeParams", {
  cameraA: f32,
  cameraB: f32,
  cameraC: f32,
  cameraD: f32,
  cameraTx: f32,
  cameraTy: f32,
  screenWidth: f32,
  screenHeight: f32,
  time: f32,
  baseWindX: f32,
  baseWindY: f32,
  noiseSpatialScale: f32,
  noiseTimeScale: f32,
  speedVariation: f32,
  angleVariation: f32,
  flowCyclePeriod: f32,
  slowTimeScale: f32,
  timeOfDay: f32,
  treeCount: f32,
  sunDirX: f32,
  sunDirY: f32,
  edgeVertexCount: f32,
});

// Inline the simplex3D and calculateWindVelocity WGSL code
const SIMPLEX_CODE = fn_simplex3D.code;
const WIND_CODE = fn_calculateWindVelocity.code;

const SHADER_CODE = /*wgsl*/ `
struct TreeParams {
  cameraA: f32,
  cameraB: f32,
  cameraC: f32,
  cameraD: f32,
  cameraTx: f32,
  cameraTy: f32,
  screenWidth: f32,
  screenHeight: f32,
  time: f32,
  baseWindX: f32,
  baseWindY: f32,
  noiseSpatialScale: f32,
  noiseTimeScale: f32,
  speedVariation: f32,
  angleVariation: f32,
  flowCyclePeriod: f32,
  slowTimeScale: f32,
  timeOfDay: f32,
  treeCount: f32,
  sunDirX: f32,
  sunDirY: f32,
  edgeVertexCount: f32,
}

@group(0) @binding(0) var<uniform> params: TreeParams;
@group(0) @binding(1) var<storage, read> trees: array<vec4<f32>>;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec3<f32>,
}

const QUAD_HALF: f32 = ${QUAD_HALF}.0;
const SWAY_SCALE: f32 = 0.4;
const TWO_PI: f32 = 6.283185307;

// Bright leader tip at top of tree
const LEADER_COLOR: vec3<f32> = vec3<f32>(0.20, 0.36, 0.14);

// Simplex noise (used by wind velocity calculation in vertex shader)
${SIMPLEX_CODE}

// Wind velocity (used in vertex shader for per-tree wind)
${WIND_CODE}

// Compute the edge radius for a whorl at a given angle
fn whorlEdgeRadius(angle: f32, radius: f32, branches: f32, angularOffset: f32, bumpMag: f32, phase: f32, fi: f32) -> f32 {
  // Primary branch tips
  let branchAngle = angle * branches + angularOffset;
  let tipCos = 0.5 + 0.5 * cos(branchAngle);
  let tipShape = tipCos * tipCos;

  // Secondary sub-bumps
  let subAngle = angle * (branches * 2.0 + 1.0) + phase * 3.7 + fi * 1.9;
  let subCos = 0.5 + 0.5 * cos(subAngle);
  let subBump = subCos * subCos * subCos * 0.25;

  // Per-branch magnitude variation
  let branchVar = 0.7 + 0.3 * sin(angle * 3.17 + phase * 13.0 + fi * 5.3);

  // Single-frequency edge noise
  let edgeNoise = sin(angle * 13.7 + phase * 5.1) * 0.025;

  return radius + (tipShape * branchVar + subBump) * bumpMag + edgeNoise;
}

@vertex
fn vs_main(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
) -> VertexOutput {
  let edgeCount = u32(params.edgeVertexCount);
  let verticesPerFan = edgeCount * 3u;

  // Decode layer and triangle from vertex index
  // Layers 0-4 = whorls (bottom to top), layer 5 = leader
  let layer = vertexIndex / verticesPerFan;
  let fanVertex = vertexIndex % verticesPerFan;
  let triangleIndex = fanVertex / 3u;
  let cornerInTriangle = fanVertex % 3u;

  let isLeader = layer == 5u;

  let tree = trees[instanceIndex];
  let treeX = tree.x;
  let treeY = tree.y;
  let phase = tree.z;

  // Per-tree size variation
  let sizeVar = 0.65 + fract(phase * 3.17) * 0.70;

  // Compute wind at tree position
  let windVel = calculateWindVelocity(
    vec2<f32>(treeX, treeY),
    params.time,
    vec2<f32>(params.baseWindX, params.baseWindY),
    1.0, 0.0, 0.0,
    params.noiseSpatialScale,
    params.noiseTimeScale,
    params.speedVariation,
    params.angleVariation,
    params.flowCyclePeriod,
    params.slowTimeScale
  );

  let windSpeed = length(windVel);
  let swayAmount = windSpeed * SWAY_SCALE;
  let invSpeed = select(0.0, 1.0 / windSpeed, windSpeed > 0.01);
  let windDir = windVel * invSpeed;

  // Per-layer sway offset in UV space
  let treePos = vec2<f32>(treeX, treeY);
  var swayOffset = vec2<f32>(0.0, 0.0);
  if (isLeader) {
    swayOffset = windDir * swayAmount * 1.1 * sizeVar / QUAD_HALF;
  } else {
    let fi = f32(layer);
    let height = fi / 4.0;
    let osc = sin(params.time * 1.8 + phase + fi * 0.5) * 0.03;
    swayOffset = windDir * swayAmount * height * sizeVar * (1.0 + osc) / QUAD_HALF;
  }

  // Whorl center in world space
  let centerWorld = treePos + swayOffset * QUAD_HALF;

  // Compute vertex position and color
  var worldPos: vec2<f32>;
  var vertColor: vec3<f32>;

  if (isLeader) {
    // --- Leader tip: small circle ---
    let leaderRadius: f32 = 0.045;
    if (cornerInTriangle == 0u) {
      worldPos = centerWorld;
    } else {
      let edgeIdx = select(triangleIndex, triangleIndex + 1u, cornerInTriangle == 2u);
      let angle = f32(edgeIdx) * TWO_PI / f32(edgeCount);
      worldPos = centerWorld + vec2<f32>(cos(angle), sin(angle)) * leaderRadius * QUAD_HALF;
    }
    vertColor = LEADER_COLOR;
  } else {
    // --- Whorl: bumpy polygon with AO gradient ---
    let fi = f32(layer);
    let height = fi / 4.0;
    let whorlRadius = (0.64 - fi * 0.10) * sizeVar;
    let branches = 5.0 + fract(phase * 1.37 + fi * 0.23) * 3.0;
    let angularOffset = fi * 0.9 + phase;
    let bumpMag = (0.08 + 0.02 * sin(fi * 2.3 + phase)) * sizeVar;

    // Whorl base color
    let lum = 0.16 + height * 0.12;
    let hueShift = fract(phase * 2.71);
    let coolGreen = vec3<f32>(lum * 0.40, lum, lum * 0.45);
    let warmGreen = vec3<f32>(lum * 0.55, lum, lum * 0.25);
    let whorlBaseColor = mix(coolGreen, warmGreen, hueShift);

    if (cornerInTriangle == 0u) {
      // Center vertex: dark (AO effect)
      worldPos = centerWorld;
      vertColor = whorlBaseColor * 0.65;
    } else {
      // Edge vertex: full color with sun-side lighting
      let edgeIdx = select(triangleIndex, triangleIndex + 1u, cornerInTriangle == 2u);
      let angle = f32(edgeIdx) * TWO_PI / f32(edgeCount);
      let edgeR = whorlEdgeRadius(angle, whorlRadius, branches, angularOffset, bumpMag, phase, fi);
      worldPos = centerWorld + vec2<f32>(cos(angle), sin(angle)) * edgeR * QUAD_HALF;

      // Sun-side lighting
      let radialDir = vec2<f32>(cos(angle), sin(angle));
      let sunDir2 = vec2<f32>(params.sunDirX, params.sunDirY);
      let sunDot = dot(radialDir, sunDir2);
      vertColor = whorlBaseColor * (0.85 + 0.15 * sunDot);
    }
  }

  // World → screen via camera matrix (2x3 affine)
  let screenX = params.cameraA * worldPos.x + params.cameraC * worldPos.y + params.cameraTx;
  let screenY = params.cameraB * worldPos.x + params.cameraD * worldPos.y + params.cameraTy;

  // Screen → NDC
  let ndcX = 2.0 * screenX / params.screenWidth - 1.0;
  let ndcY = 2.0 * screenY / params.screenHeight - 1.0;

  // Depth: layer 0 = 0.9 (farthest), layer 5 (leader) = 0.4 (nearest)
  let z = 0.9 - f32(layer) * 0.1;

  var out: VertexOutput;
  out.position = vec4<f32>(ndcX, ndcY, z, 1.0);
  out.color = vertColor;
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  return vec4<f32>(in.color, 1.0);
}
`;

/**
 * Compute edge count from camera zoom.
 */
function getEdgeCount(zoom: number): number {
  if (zoom < 0.3) return EDGE_COUNTS[0]; // 6
  if (zoom < 1) return EDGE_COUNTS[1]; // 8
  if (zoom < 3) return EDGE_COUNTS[2]; // 16
  if (zoom < 7) return EDGE_COUNTS[3]; // 32
  if (zoom < 14) return EDGE_COUNTS[4]; // 48
  return EDGE_COUNTS[5]; // 64
}

/**
 * GPU instanced tree renderer using polygon mesh geometry.
 */
export class TreeRasterizer {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private uniforms: UniformInstance<typeof TreeUniforms.fields> =
    TreeUniforms.create();
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private treeBuffer: GPUBuffer | null = null;
  private treeBufferCapacity = 0;
  private initialized = false;

  // Offscreen texture for rendering trees to a separate render pass
  private offscreenTexture: GPUTexture | null = null;
  private offscreenTextureView: GPUTextureView | null = null;
  private depthTexture: GPUTexture | null = null;
  private depthTextureView: GPUTextureView | null = null;
  private offscreenWidth = 0;
  private offscreenHeight = 0;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    const device = this.device;
    const gpu = getWebGPU();

    const shaderModule = await gpu.createShaderModuleChecked(
      SHADER_CODE,
      "Tree Rasterizer Shader",
    );

    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "read-only-storage" },
        },
      ],
      label: "Tree Rasterizer Bind Group Layout",
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
      label: "Tree Rasterizer Pipeline Layout",
    });

    this.pipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [
          {
            format: OFFSCREEN_FORMAT,
          },
        ],
      },
      primitive: {
        topology: "triangle-list",
      },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthCompare: "less-equal",
        depthWriteEnabled: true,
      },
      label: "Tree Rasterizer Pipeline",
    });

    this.uniformBuffer = device.createBuffer({
      size: TreeUniforms.byteSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Tree Rasterizer Uniforms",
    });

    // Start with a small tree buffer, will grow as needed
    this.treeBufferCapacity = 256;
    this.treeBuffer = device.createBuffer({
      size: this.treeBufferCapacity * 16, // vec4<f32> = 16 bytes
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: "Tree Instance Buffer",
    });

    this.rebuildBindGroup();
    this.initialized = true;
  }

  private rebuildBindGroup(): void {
    if (!this.bindGroupLayout || !this.uniformBuffer || !this.treeBuffer)
      return;
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.treeBuffer } },
      ],
      label: "Tree Rasterizer Bind Group",
    });
  }

  /**
   * Upload visible tree data to the GPU storage buffer.
   * Data is a Float32Array with stride 4: [x, y, phase, 0] per tree.
   */
  updateTreeBuffer(data: Float32Array, count: number): void {
    if (!this.initialized) return;

    // Grow buffer if needed
    if (count > this.treeBufferCapacity) {
      this.treeBuffer?.destroy();
      this.treeBufferCapacity = Math.max(count, this.treeBufferCapacity * 2);
      this.treeBuffer = this.device.createBuffer({
        size: this.treeBufferCapacity * 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        label: "Tree Instance Buffer",
      });
      this.rebuildBindGroup();
    }

    if (count > 0) {
      const byteLength = count * 16;
      this.device.queue.writeBuffer(
        this.treeBuffer!,
        0,
        data.buffer,
        data.byteOffset,
        byteLength,
      );
    }
  }

  /**
   * Render trees into the current render pass.
   */
  render(
    renderPass: GPURenderPassEncoder,
    treeCount: number,
    cameraA: number,
    cameraB: number,
    cameraC: number,
    cameraD: number,
    cameraTx: number,
    cameraTy: number,
    screenWidth: number,
    screenHeight: number,
    time: number,
    baseWindX: number,
    baseWindY: number,
    timeOfDay: number,
    zoom: number,
  ): void {
    if (
      !this.initialized ||
      !this.pipeline ||
      !this.uniformBuffer ||
      !this.bindGroup ||
      treeCount === 0
    )
      return;

    const edgeCount = getEdgeCount(zoom);
    const verticesPerTree = edgeCount * 3 * NUM_LAYERS;

    // Update uniforms
    this.uniforms.set.cameraA(cameraA);
    this.uniforms.set.cameraB(cameraB);
    this.uniforms.set.cameraC(cameraC);
    this.uniforms.set.cameraD(cameraD);
    this.uniforms.set.cameraTx(cameraTx);
    this.uniforms.set.cameraTy(cameraTy);
    this.uniforms.set.screenWidth(screenWidth);
    this.uniforms.set.screenHeight(screenHeight);
    this.uniforms.set.time(time);
    this.uniforms.set.baseWindX(baseWindX);
    this.uniforms.set.baseWindY(baseWindY);
    this.uniforms.set.noiseSpatialScale(WIND_NOISE_SPATIAL_SCALE);
    this.uniforms.set.noiseTimeScale(WIND_NOISE_TIME_SCALE);
    this.uniforms.set.speedVariation(WIND_SPEED_VARIATION);
    this.uniforms.set.angleVariation(WIND_ANGLE_VARIATION);
    this.uniforms.set.flowCyclePeriod(WIND_FLOW_CYCLE_PERIOD);
    this.uniforms.set.slowTimeScale(WIND_SLOW_TIME_SCALE);
    this.uniforms.set.timeOfDay(timeOfDay);
    this.uniforms.set.treeCount(treeCount);
    this.uniforms.set.edgeVertexCount(edgeCount);

    // Precompute sun direction on CPU (saves 5 trig ops per fragment)
    const hour = timeOfDay / 3600;
    const sunPhase = ((hour - 6) * Math.PI) / 12;
    const elevation = Math.sin(sunPhase);
    const sunElevation = Math.max(elevation, 0);
    const azimuth = ((hour - 12) * Math.PI) / 6;
    const sx = Math.cos(azimuth) * 0.3 + 0.3;
    const sy = Math.sin(azimuth) * 0.2 + 0.2;
    const sz = sunElevation * 0.9 + 0.1;
    const sunLen2d = Math.sqrt(sx * sx + sy * sy);
    this.uniforms.set.sunDirX(sunLen2d > 0 ? sx / sunLen2d : 1);
    this.uniforms.set.sunDirY(sunLen2d > 0 ? sy / sunLen2d : 0);

    this.uniforms.uploadTo(this.uniformBuffer);

    renderPass.setPipeline(this.pipeline);
    renderPass.setBindGroup(0, this.bindGroup);

    // Single draw call: all layers encoded in vertexIndex
    renderPass.draw(verticesPerTree, treeCount);
  }

  /**
   * Ensure offscreen texture and depth texture match the screen dimensions.
   */
  private ensureOffscreenTexture(width: number, height: number): void {
    if (this.offscreenWidth === width && this.offscreenHeight === height)
      return;

    this.offscreenTexture?.destroy();
    this.offscreenTexture = this.device.createTexture({
      size: { width, height },
      format: OFFSCREEN_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      label: "Tree Offscreen Texture",
    });
    this.offscreenTextureView = this.offscreenTexture.createView();

    this.depthTexture?.destroy();
    this.depthTexture = this.device.createTexture({
      size: { width, height },
      format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
      label: "Tree Depth Texture",
    });
    this.depthTextureView = this.depthTexture.createView();

    this.offscreenWidth = width;
    this.offscreenHeight = height;
  }

  /**
   * Get the offscreen texture view for compositing.
   */
  getTextureView(): GPUTextureView | null {
    return this.offscreenTextureView;
  }

  /**
   * Render trees to the offscreen texture using a separate command encoder.
   * This avoids interrupting the main render pass, which is expensive on
   * tile-based GPUs. The texture can then be composited into the main pass.
   */
  renderToTexture(
    treeCount: number,
    cameraA: number,
    cameraB: number,
    cameraC: number,
    cameraD: number,
    cameraTx: number,
    cameraTy: number,
    screenWidth: number,
    screenHeight: number,
    textureWidth: number,
    textureHeight: number,
    time: number,
    baseWindX: number,
    baseWindY: number,
    timeOfDay: number,
    zoom: number,
    gpuProfiler: GPUProfiler | null,
  ): void {
    if (!this.initialized || treeCount === 0) return;

    this.ensureOffscreenTexture(textureWidth, textureHeight);

    const encoder = this.device.createCommandEncoder({
      label: "Tree Render",
    });

    const renderPass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.offscreenTextureView!,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
      depthStencilAttachment: {
        view: this.depthTextureView!,
        depthLoadOp: "clear",
        depthStoreOp: "store",
        depthClearValue: 1.0,
      },
      timestampWrites: gpuProfiler?.getTimestampWrites("trees"),
      label: "Trees Render Pass",
    });

    this.render(
      renderPass,
      treeCount,
      cameraA,
      cameraB,
      cameraC,
      cameraD,
      cameraTx,
      cameraTy,
      screenWidth,
      screenHeight,
      time,
      baseWindX,
      baseWindY,
      timeOfDay,
      zoom,
    );

    renderPass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
    this.treeBuffer?.destroy();
    this.offscreenTexture?.destroy();
    this.depthTexture?.destroy();
    this.uniformBuffer = null;
    this.treeBuffer = null;
    this.offscreenTexture = null;
    this.offscreenTextureView = null;
    this.depthTexture = null;
    this.depthTextureView = null;
    this.pipeline = null;
    this.bindGroup = null;
    this.bindGroupLayout = null;
    this.initialized = false;
  }
}
