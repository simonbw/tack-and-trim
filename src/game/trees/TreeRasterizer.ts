/**
 * GPU instanced tree renderer.
 *
 * Renders trees as instanced quads with wind sway computed on GPU.
 * Each tree is a vec4(x, y, phase, 0) in a storage buffer.
 * Vertex shader generates 6 vertices per instance (2-triangle quad),
 * computes wind sway from simplex noise, and shifts top vertices downwind.
 * Fragment shader draws a placeholder canopy + trunk using SDF circles.
 */

import {
  defineUniformStruct,
  f32,
  type UniformInstance,
} from "../../core/graphics/UniformStruct";
import { getWebGPU } from "../../core/graphics/webgpu/WebGPUDevice";
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

// Tree dimensions (must match TreeManager constants)
const OUTER_RADIUS = 12;
const QUAD_HALF = OUTER_RADIUS + 2; // slight padding for smoothstep edges

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
}

@group(0) @binding(0) var<uniform> params: TreeParams;
@group(0) @binding(1) var<storage, read> trees: array<vec4<f32>>;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) windStrength: f32,
}

const QUAD_HALF: f32 = ${QUAD_HALF}.0;
const SWAY_SCALE: f32 = 0.15;
const SWAY_FREQ: f32 = 1.8;

// Simplex noise
${SIMPLEX_CODE}

// Wind velocity
${WIND_CODE}

@vertex
fn vs_main(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
) -> VertexOutput {
  let tree = trees[instanceIndex];
  let treeX = tree.x;
  let treeY = tree.y;
  let phase = tree.z;

  // Compute wind at tree position (no terrain influence for trees)
  let windVel = calculateWindVelocity(
    vec2<f32>(treeX, treeY),
    params.time,
    vec2<f32>(params.baseWindX, params.baseWindY),
    1.0, // influenceSpeedFactor (no terrain influence)
    0.0, // influenceDirectionOffset
    0.0, // influenceTurbulence
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
  let windDirX = windVel.x * invSpeed;
  let windDirY = windVel.y * invSpeed;
  let perpX = -windDirY;
  let perpY = windDirX;

  // Per-tree oscillation
  let oscillation = sin(params.time * SWAY_FREQ + phase);
  let oscillationPerp = cos(params.time * SWAY_FREQ + phase) * 0.3;

  let tipDx = windDirX * swayAmount * (1.0 + oscillation * 0.3)
            + perpX * swayAmount * oscillationPerp;
  let tipDy = windDirY * swayAmount * (1.0 + oscillation * 0.3)
            + perpY * swayAmount * oscillationPerp;

  // 6 vertices per quad: 2 triangles
  // Quad corners: (-1,-1), (1,-1), (1,1), (-1,1) in local space
  // Triangle 1: 0,1,2  Triangle 2: 0,2,3
  var localX: f32;
  var localY: f32;
  var u: f32;
  var v: f32;
  switch (vertexIndex % 6u) {
    case 0u: { localX = -1.0; localY = -1.0; u = 0.0; v = 0.0; }
    case 1u: { localX =  1.0; localY = -1.0; u = 1.0; v = 0.0; }
    case 2u: { localX =  1.0; localY =  1.0; u = 1.0; v = 1.0; }
    case 3u: { localX = -1.0; localY = -1.0; u = 0.0; v = 0.0; }
    case 4u: { localX =  1.0; localY =  1.0; u = 1.0; v = 1.0; }
    default: { localX = -1.0; localY =  1.0; u = 0.0; v = 1.0; }
  }

  // World position of this vertex
  var worldX = treeX + localX * QUAD_HALF;
  var worldY = treeY + localY * QUAD_HALF;

  // Shift top half of quad by wind sway (v > 0.5 means top)
  let swayFactor = max(0.0, (v - 0.3) / 0.7); // gradual from 30% up
  worldX += tipDx * swayFactor;
  worldY += tipDy * swayFactor;

  // World → screen via camera matrix (2x3 affine)
  let screenX = params.cameraA * worldX + params.cameraC * worldY + params.cameraTx;
  let screenY = params.cameraB * worldX + params.cameraD * worldY + params.cameraTy;

  // Screen → NDC
  let ndcX = 2.0 * screenX / params.screenWidth - 1.0;
  let ndcY = 2.0 * screenY / params.screenHeight - 1.0;

  var out: VertexOutput;
  out.position = vec4<f32>(ndcX, ndcY, 0.0, 1.0);
  out.uv = vec2<f32>(u, v);
  out.windStrength = swayAmount;
  return out;
}

// Colors
const CANOPY_GREEN: vec3<f32> = vec3<f32>(0.102, 0.251, 0.063);
const TRUNK_BROWN: vec3<f32> = vec3<f32>(0.239, 0.126, 0.031);

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  // UV centered at (0.5, 0.5), range [-1, 1]
  let centered = (in.uv - vec2<f32>(0.5, 0.5)) * 2.0;
  let dist = length(centered);

  // Canopy: star-like shape using angular variation
  let angle = atan2(centered.y, centered.x);
  let starRadius = 0.75 + 0.1 * sin(angle * 6.0);
  let canopyAlpha = 1.0 - smoothstep(starRadius - 0.08, starRadius + 0.08, dist);

  // Trunk: small circle at center
  let trunkRadius = 0.1;
  let trunkAlpha = 1.0 - smoothstep(trunkRadius - 0.03, trunkRadius + 0.03, dist);

  // Combine: trunk on top of canopy
  let color = mix(CANOPY_GREEN, TRUNK_BROWN, trunkAlpha);
  let alpha = max(canopyAlpha, trunkAlpha);

  if (alpha < 0.01) {
    discard;
  }

  return vec4<f32>(color, alpha);
}
`;

/**
 * GPU instanced tree renderer.
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
      primitive: {
        topology: "triangle-list",
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
  ): void {
    if (
      !this.initialized ||
      !this.pipeline ||
      !this.uniformBuffer ||
      !this.bindGroup ||
      treeCount === 0
    )
      return;

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
    this.uniforms.uploadTo(this.uniformBuffer);

    renderPass.setPipeline(this.pipeline);
    renderPass.setBindGroup(0, this.bindGroup);
    renderPass.draw(6, treeCount); // 6 vertices per quad instance
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
    this.treeBuffer?.destroy();
    this.uniformBuffer = null;
    this.treeBuffer = null;
    this.pipeline = null;
    this.bindGroup = null;
    this.bindGroupLayout = null;
    this.initialized = false;
  }
}
