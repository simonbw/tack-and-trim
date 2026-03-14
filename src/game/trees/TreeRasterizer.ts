/**
 * GPU instanced tree renderer.
 *
 * Renders trees as instanced quads with wind sway computed on GPU.
 * Each tree is a vec4(x, y, phase, 0) in a storage buffer.
 * Vertex shader generates 6 vertices per instance (2-triangle quad),
 * computes wind velocity via simplex noise, and passes it to the fragment
 * shader as a flat varying. Fragment shader renders 5 concentric branch
 * whorls composited back-to-front, each shifted by wind proportional to
 * its height for a parallax depth effect.
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

// Quad half-extent in world feet. Must be large enough for the biggest tree
// (outer whorl ~0.64 UV * sizeVar 1.35 + bumps ≈ 0.95 UV → 0.95 * 18 = 17.1 ft).
const QUAD_HALF = 18;

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
  @location(1) @interpolate(flat) windVelX: f32,
  @location(2) @interpolate(flat) windVelY: f32,
  @location(3) @interpolate(flat) phase: f32,
}

const QUAD_HALF: f32 = ${QUAD_HALF}.0;
const SWAY_SCALE: f32 = 0.4;

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
    1.0, 0.0, 0.0,
    params.noiseSpatialScale,
    params.noiseTimeScale,
    params.speedVariation,
    params.angleVariation,
    params.flowCyclePeriod,
    params.slowTimeScale
  );

  // 6 vertices per quad: 2 triangles
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

  // World position — no quad sway; fragment shader handles per-whorl sway
  let worldX = treeX + localX * QUAD_HALF;
  let worldY = treeY + localY * QUAD_HALF;

  // World → screen via camera matrix (2x3 affine)
  let screenX = params.cameraA * worldX + params.cameraC * worldY + params.cameraTx;
  let screenY = params.cameraB * worldX + params.cameraD * worldY + params.cameraTy;

  // Screen → NDC
  let ndcX = 2.0 * screenX / params.screenWidth - 1.0;
  let ndcY = 2.0 * screenY / params.screenHeight - 1.0;

  var out: VertexOutput;
  out.position = vec4<f32>(ndcX, ndcY, 0.0, 1.0);
  out.uv = vec2<f32>(u, v);
  out.windVelX = windVel.x;
  out.windVelY = windVel.y;
  out.phase = phase;
  return out;
}

// ---- Fragment shader: layered evergreen canopy ----

// Dark interior visible between whorls (trunk/shadow)
const TRUNK_COLOR: vec3<f32> = vec3<f32>(0.04, 0.07, 0.03);
// Bright leader tip at top of tree
const LEADER_COLOR: vec3<f32> = vec3<f32>(0.20, 0.36, 0.14);

// Number of branch whorls (tiers)
const NUM_WHORLS: i32 = 5;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  // Centered UV: [-1, 1]
  let centered = (in.uv - vec2<f32>(0.5)) * 2.0;

  // Wind sway setup
  let windVel = vec2<f32>(in.windVelX, in.windVelY);
  let windSpeed = length(windVel);
  let swayAmount = windSpeed * SWAY_SCALE;
  let invSpeed = select(0.0, 1.0 / windSpeed, windSpeed > 0.01);
  let windDir = windVel * invSpeed;
  let perpDir = vec2<f32>(-windDir.y, windDir.x);

  // Per-tree size variation (0.65x to 1.35x for visible variety)
  let sizeVar = 0.65 + fract(in.phase * 3.17) * 0.70;

  // Premultiplied alpha accumulator
  var pm = vec3<f32>(0.0);
  var a: f32 = 0.0;

  // Dark trunk/shadow base disc (no sway — it's the ground-level footprint)
  let trunkDist = length(centered);
  let trunkR: f32 = 0.61 * sizeVar;
  let trunkAlpha = (1.0 - smoothstep(trunkR - 0.04, trunkR + 0.02, trunkDist)) * 0.92;
  pm = TRUNK_COLOR * trunkAlpha + pm * (1.0 - trunkAlpha);
  a = trunkAlpha + a * (1.0 - trunkAlpha);

  // Composite whorls from outermost (lowest) to innermost (highest)
  for (var w: i32 = 0; w < NUM_WHORLS; w = w + 1) {
    let fi = f32(w);
    let height = fi / f32(NUM_WHORLS - 1); // 0 (ground) to 1 (top)

    // Wind-only sway: lean proportional to whorl height, scaled by tree size
    let swayUV = windDir * swayAmount * height * sizeVar / QUAD_HALF;

    // Shifted position for this whorl
    let shiftedPos = centered - swayUV;
    let dist = length(shiftedPos);
    let angle = atan2(shiftedPos.y, shiftedPos.x);

    // Whorl shape — fractional branch count per tree+whorl breaks polygon regularity
    let radius = (0.64 - fi * 0.10) * sizeVar;
    let branches = 5.0 + fract(in.phase * 1.37 + fi * 0.23) * 3.0; // 5.0–8.0
    let angularOffset = fi * 0.9 + in.phase;

    // Primary branch tips
    let branchAngle = angle * branches + angularOffset;
    let tipShape = pow(0.5 + 0.5 * cos(branchAngle), 2.0);

    // Secondary sub-bumps at different frequency for organic irregularity
    let subAngle = angle * (branches * 2.0 + 1.0) + in.phase * 3.7 + fi * 1.9;
    let subBump = pow(0.5 + 0.5 * cos(subAngle), 3.0) * 0.25;

    // Per-branch magnitude variation — some branches reach further
    let branchVar = 0.7 + 0.3 * sin(angle * 3.17 + in.phase * 13.0 + fi * 5.3);

    // Multi-frequency edge noise
    let edgeNoise = sin(angle * 13.7 + in.phase * 5.1) * 0.02
                  + sin(angle * 23.1 + in.phase * 11.3 + fi * 3.7) * 0.015
                  + sin(angle * 37.3 + in.phase * 7.9) * 0.008;

    // Combined bump
    let baseBumpMag = (0.08 + 0.02 * sin(fi * 2.3 + in.phase)) * sizeVar;
    let edgeR = radius + (tipShape * branchVar + subBump) * baseBumpMag + edgeNoise;

    // Whorl base coverage — sharper edge
    let baseAlpha = 1.0 - smoothstep(edgeR - 0.03, edgeR + 0.015, dist);

    // Valley coverage — less transparent than before for crisper lower layers
    let valleyCoverage = smoothstep(0.0, 0.3, tipShape);
    let whorlAlpha = baseAlpha * mix(0.65, 1.0, valleyCoverage);

    // Color: progressively lighter for upper whorls
    let lum = 0.16 + height * 0.12;
    let whorlBaseColor = vec3<f32>(lum * 0.50, lum, lum * 0.35);

    // Gentler AO: darker near center, lighter at tips
    let tipLighting = smoothstep(radius * 0.4, radius, dist);
    let whorlColor = mix(whorlBaseColor * 0.65, whorlBaseColor, tipLighting);

    // Drop shadow: darken area just outside this whorl's edge
    let shadowDist = dist - edgeR;
    let shadowStr = smoothstep(0.08, 0.0, shadowDist) * 0.18 * (1.0 - baseAlpha);
    pm = pm * (1.0 - shadowStr);

    // Composite whorl over accumulated layers
    pm = whorlColor * whorlAlpha + pm * (1.0 - whorlAlpha);
    a = whorlAlpha + a * (1.0 - whorlAlpha);
  }

  // Leader (topmost point) — sways most, wind-only, scaled by tree size
  let leaderShift = windDir * swayAmount * 1.1 * sizeVar / QUAD_HALF;
  let leaderPos = centered - leaderShift;
  let leaderDist = length(leaderPos);
  let leaderAlpha = 1.0 - smoothstep(0.03, 0.06, leaderDist);
  pm = LEADER_COLOR * leaderAlpha + pm * (1.0 - leaderAlpha);
  a = leaderAlpha + a * (1.0 - leaderAlpha);

  if (a < 0.01) {
    discard;
  }

  // Convert premultiplied → straight alpha for framebuffer blending
  let finalColor = pm / a;
  return vec4<f32>(finalColor, a);
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
