/**
 * Unified water state compute shader.
 *
 * Single source of truth for water computation combining:
 * - Gerstner wave simulation with simplex noise modulation
 * - Wake modifier contributions from boat wakes
 *
 * Output format (rgba32float):
 * - R: Combined height (waves + modifiers), normalized
 * - G: dh/dt (rate of height change), normalized
 * - B: Water velocity X (from modifiers), normalized
 * - A: Water velocity Y (from modifiers), normalized
 *
 * This class owns the compute pipeline and bind group layout.
 * Callers (rendering pipeline, physics tiles) own their textures
 * and create bind groups using the layout from this class.
 */

import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import {
  NUM_WAVES,
  GERSTNER_STEEPNESS,
  GRAVITY_FT_PER_S2,
  WAVE_AMP_MOD_SPATIAL_SCALE,
  WAVE_AMP_MOD_TIME_SCALE,
  WAVE_AMP_MOD_STRENGTH,
} from "../WaterConstants";
import { MAX_SEGMENTS, FLOATS_PER_SEGMENT } from "./WaterComputeBuffers";

// Constants for modifier computation
const HEIGHT_SCALE = 0.5;
const WATER_VELOCITY_FACTOR = 0.0; // Set to non-zero to enable velocity from wakes

/**
 * WGSL compute shader for unified water state computation.
 */
export const WATER_STATE_SHADER = /*wgsl*/ `
// ============================================================================
// Constants
// ============================================================================
const PI: f32 = 3.14159265359;
const NUM_WAVES: i32 = ${NUM_WAVES};
const GERSTNER_STEEPNESS: f32 = ${GERSTNER_STEEPNESS};
const GRAVITY: f32 = ${GRAVITY_FT_PER_S2};
const WAVE_AMP_MOD_SPATIAL_SCALE: f32 = ${WAVE_AMP_MOD_SPATIAL_SCALE};
const WAVE_AMP_MOD_TIME_SCALE: f32 = ${WAVE_AMP_MOD_TIME_SCALE};
const WAVE_AMP_MOD_STRENGTH: f32 = ${WAVE_AMP_MOD_STRENGTH};
const HEIGHT_SCALE: f32 = ${HEIGHT_SCALE};
const MAX_SEGMENTS: u32 = ${MAX_SEGMENTS}u;
const FLOATS_PER_SEGMENT: u32 = ${FLOATS_PER_SEGMENT}u;
const WATER_VELOCITY_FACTOR: f32 = ${WATER_VELOCITY_FACTOR};

// ============================================================================
// Uniforms and Bindings
// ============================================================================
struct Params {
  time: f32,
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  textureSizeX: f32,
  textureSizeY: f32,
  segmentCount: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> waveData: array<f32>;
@group(0) @binding(2) var<storage, read> segments: array<f32>;
@group(0) @binding(3) var outputTexture: texture_storage_2d<rgba32float, write>;

// ============================================================================
// Simplex 3D Noise - for wave amplitude modulation
// ============================================================================

fn mod289_3(x: vec3<f32>) -> vec3<f32> {
  return x - floor(x * (1.0 / 289.0)) * 289.0;
}

fn mod289_4(x: vec4<f32>) -> vec4<f32> {
  return x - floor(x * (1.0 / 289.0)) * 289.0;
}

fn permute(x: vec4<f32>) -> vec4<f32> {
  return mod289_4(((x * 34.0) + 10.0) * x);
}

fn taylorInvSqrt(r: vec4<f32>) -> vec4<f32> {
  return 1.79284291400159 - 0.85373472095314 * r;
}

fn simplex3D(v: vec3<f32>) -> f32 {
  let C = vec2<f32>(1.0 / 6.0, 1.0 / 3.0);
  let D = vec4<f32>(0.0, 0.5, 1.0, 2.0);

  var i = floor(v + dot(v, C.yyy));
  let x0 = v - i + dot(i, C.xxx);

  let g = step(x0.yzx, x0.xyz);
  let l = 1.0 - g;
  let i1 = min(g.xyz, l.zxy);
  let i2 = max(g.xyz, l.zxy);

  let x1 = x0 - i1 + C.xxx;
  let x2 = x0 - i2 + C.yyy;
  let x3 = x0 - D.yyy;

  i = mod289_3(i);
  let p = permute(permute(permute(
      i.z + vec4<f32>(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4<f32>(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4<f32>(0.0, i1.x, i2.x, 1.0));

  let n_ = 0.142857142857;
  let ns = n_ * D.wyz - D.xzx;

  let j = p - 49.0 * floor(p * ns.z * ns.z);

  let x_ = floor(j * ns.z);
  let y_ = floor(j - 7.0 * x_);

  let x = x_ * ns.x + ns.yyyy;
  let y = y_ * ns.x + ns.yyyy;
  let h = 1.0 - abs(x) - abs(y);

  let b0 = vec4<f32>(x.xy, y.xy);
  let b1 = vec4<f32>(x.zw, y.zw);

  let s0 = floor(b0) * 2.0 + 1.0;
  let s1 = floor(b1) * 2.0 + 1.0;
  let sh = -step(h, vec4<f32>(0.0));

  let a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  let a1 = b1.xzyw + s1.xzyw * sh.zzww;

  var p0 = vec3<f32>(a0.xy, h.x);
  var p1 = vec3<f32>(a0.zw, h.y);
  var p2 = vec3<f32>(a1.xy, h.z);
  var p3 = vec3<f32>(a1.zw, h.w);

  let norm = taylorInvSqrt(vec4<f32>(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 = p0 * norm.x;
  p1 = p1 * norm.y;
  p2 = p2 * norm.z;
  p3 = p3 * norm.w;

  var m = max(0.6 - vec4<f32>(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), vec4<f32>(0.0));
  m = m * m;
  return 42.0 * dot(m * m, vec4<f32>(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

// ============================================================================
// Hash function for white noise
// ============================================================================

fn hash2D(x: f32, y: f32) -> f32 {
  let n = sin(x * 127.1 + y * 311.7) * 43758.5453;
  return fract(n);
}

// ============================================================================
// Section 1: Gerstner Wave Calculation
// ============================================================================

fn calculateWaves(worldPos: vec2<f32>, time: f32) -> vec4<f32> {
  let x = worldPos.x;
  let y = worldPos.y;

  // Sample amplitude modulation noise once per point
  let ampModTime = time * WAVE_AMP_MOD_TIME_SCALE;
  let ampMod = 1.0 + simplex3D(vec3<f32>(
    x * WAVE_AMP_MOD_SPATIAL_SCALE,
    y * WAVE_AMP_MOD_SPATIAL_SCALE,
    ampModTime
  )) * WAVE_AMP_MOD_STRENGTH;

  // First pass: compute Gerstner horizontal displacement
  var dispX = 0.0;
  var dispY = 0.0;

  for (var i = 0; i < NUM_WAVES; i++) {
    let base = i * 8;
    let amplitude = waveData[base + 0];
    let wavelength = waveData[base + 1];
    let direction = waveData[base + 2];
    let phaseOffset = waveData[base + 3];
    let speedMult = waveData[base + 4];
    let sourceDist = waveData[base + 5];
    let sourceOffsetX = waveData[base + 6];
    let sourceOffsetY = waveData[base + 7];

    let baseDx = cos(direction);
    let baseDy = sin(direction);
    let k = (2.0 * PI) / wavelength;
    let omega = sqrt(GRAVITY * k) * speedMult;

    var dx: f32;
    var dy: f32;
    var phase: f32;

    if (sourceDist > 1e9) {
      dx = baseDx;
      dy = baseDy;
      let projected = x * dx + y * dy;
      phase = k * projected - omega * time + phaseOffset;
    } else {
      let sourceX = -baseDx * sourceDist + sourceOffsetX;
      let sourceY = -baseDy * sourceDist + sourceOffsetY;

      let toPointX = x - sourceX;
      let toPointY = y - sourceY;
      let distFromSource = sqrt(toPointX * toPointX + toPointY * toPointY);

      dx = toPointX / distFromSource;
      dy = toPointY / distFromSource;
      phase = k * distFromSource - omega * time + phaseOffset;
    }

    let Q = GERSTNER_STEEPNESS / (k * amplitude * f32(NUM_WAVES));
    let cosPhase = cos(phase);
    dispX += Q * amplitude * dx * cosPhase;
    dispY += Q * amplitude * dy * cosPhase;
  }

  // Second pass: compute height and dh/dt at displaced position
  let sampleX = x - dispX;
  let sampleY = y - dispY;
  var height = 0.0;
  var dhdt = 0.0;

  for (var i = 0; i < NUM_WAVES; i++) {
    let base = i * 8;
    let amplitude = waveData[base + 0];
    let wavelength = waveData[base + 1];
    let direction = waveData[base + 2];
    let phaseOffset = waveData[base + 3];
    let speedMult = waveData[base + 4];
    let sourceDist = waveData[base + 5];
    let sourceOffsetX = waveData[base + 6];
    let sourceOffsetY = waveData[base + 7];

    let baseDx = cos(direction);
    let baseDy = sin(direction);
    let k = (2.0 * PI) / wavelength;
    let omega = sqrt(GRAVITY * k) * speedMult;

    var phase: f32;

    if (sourceDist > 1e9) {
      let projected = sampleX * baseDx + sampleY * baseDy;
      phase = k * projected - omega * time + phaseOffset;
    } else {
      let sourceX = -baseDx * sourceDist + sourceOffsetX;
      let sourceY = -baseDy * sourceDist + sourceOffsetY;

      let toPointX = sampleX - sourceX;
      let toPointY = sampleY - sourceY;
      let distFromSource = sqrt(toPointX * toPointX + toPointY * toPointY);

      phase = k * distFromSource - omega * time + phaseOffset;
    }

    let sinPhase = sin(phase);
    let cosPhase = cos(phase);

    height += amplitude * ampMod * sinPhase;
    dhdt += -amplitude * ampMod * omega * cosPhase;
  }

  // Add surface turbulence
  let smoothTurbulence =
    simplex3D(vec3<f32>(x * 0.15, y * 0.15, time * 0.5)) * 0.03 +
    simplex3D(vec3<f32>(x * 0.4, y * 0.4, time * 0.8)) * 0.01;

  let timeCell = floor(time * 0.5);
  let whiteTurbulence = (hash2D(x * 0.5 + timeCell, y * 0.5) - 0.5) * 0.02;

  height += smoothTurbulence + whiteTurbulence;

  return vec4<f32>(height, dispX, dispY, dhdt);
}

// ============================================================================
// Section 2: Wake Modifier Calculation
// ============================================================================

fn getSegmentContribution(worldX: f32, worldY: f32, segmentIndex: u32) -> vec3<f32> {
  let base = segmentIndex * FLOATS_PER_SEGMENT;

  let startX = segments[base + 0u];
  let startY = segments[base + 1u];
  let endX = segments[base + 2u];
  let endY = segments[base + 3u];
  let startRadius = segments[base + 4u];
  let endRadius = segments[base + 5u];
  let startIntensity = segments[base + 6u];
  let endIntensity = segments[base + 7u];
  let startVelX = segments[base + 8u];
  let startVelY = segments[base + 9u];
  let endVelX = segments[base + 10u];
  let endVelY = segments[base + 11u];

  let segX = endX - startX;
  let segY = endY - startY;
  let segLenSq = segX * segX + segY * segY;

  // Handle degenerate case (circle)
  if (segLenSq < 0.001) {
    let dx = worldX - startX;
    let dy = worldY - startY;
    let distSq = dx * dx + dy * dy;
    let radiusSq = startRadius * startRadius;

    if (distSq >= radiusSq) {
      return vec3<f32>(0.0, 0.0, 0.0);
    }

    let dist = sqrt(distSq);
    let t = dist / startRadius;
    let waveProfile = cos(t * PI) * (1.0 - t);
    let height = waveProfile * startIntensity * HEIGHT_SCALE;

    // Velocity: linear falloff from center
    let linearFalloff = 1.0 - t;
    let velFalloff = linearFalloff * startIntensity;
    let velX = startVelX * velFalloff * WATER_VELOCITY_FACTOR;
    let velY = startVelY * velFalloff * WATER_VELOCITY_FACTOR;

    return vec3<f32>(height, velX, velY);
  }

  // Segment contribution - project query point onto segment
  let toQueryX = worldX - startX;
  let toQueryY = worldY - startY;

  let t = clamp((toQueryX * segX + toQueryY * segY) / segLenSq, 0.0, 1.0);

  let closestX = startX + t * segX;
  let closestY = startY + t * segY;

  let perpDx = worldX - closestX;
  let perpDy = worldY - closestY;
  let perpDistSq = perpDx * perpDx + perpDy * perpDy;

  let radius = startRadius + t * (endRadius - startRadius);
  let radiusSq = radius * radius;

  if (perpDistSq >= radiusSq) {
    return vec3<f32>(0.0, 0.0, 0.0);
  }

  let perpDist = sqrt(perpDistSq);
  let normalizedDist = perpDist / radius;

  let intensity = startIntensity + t * (endIntensity - startIntensity);
  let waveProfile = cos(normalizedDist * PI) * (1.0 - normalizedDist);
  let height = waveProfile * intensity * HEIGHT_SCALE;

  // Interpolate velocity along segment
  let interpVelX = startVelX + t * (endVelX - startVelX);
  let interpVelY = startVelY + t * (endVelY - startVelY);

  // Velocity: linear falloff from ribbon center
  let linearFalloff = 1.0 - normalizedDist;
  let velFalloff = linearFalloff * intensity;
  let velX = interpVelX * velFalloff * WATER_VELOCITY_FACTOR;
  let velY = interpVelY * velFalloff * WATER_VELOCITY_FACTOR;

  return vec3<f32>(height, velX, velY);
}

fn calculateModifiers(worldX: f32, worldY: f32) -> vec3<f32> {
  var totalHeight: f32 = 0.0;
  var totalVelX: f32 = 0.0;
  var totalVelY: f32 = 0.0;

  let segCount = min(params.segmentCount, MAX_SEGMENTS);
  for (var i: u32 = 0u; i < segCount; i++) {
    let contrib = getSegmentContribution(worldX, worldY, i);
    totalHeight += contrib.x;
    totalVelX += contrib.y;
    totalVelY += contrib.z;
  }

  return vec3<f32>(totalHeight, totalVelX, totalVelY);
}

// ============================================================================
// Main: Combine wave and modifier calculations
// ============================================================================

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let texSize = vec2<f32>(params.textureSizeX, params.textureSizeY);

  if (f32(globalId.x) >= texSize.x || f32(globalId.y) >= texSize.y) {
    return;
  }

  // Convert texel to world position
  let uv = vec2<f32>(f32(globalId.x) + 0.5, f32(globalId.y) + 0.5) / texSize;
  let worldPos = vec2<f32>(
    params.viewportLeft + uv.x * params.viewportWidth,
    params.viewportTop + uv.y * params.viewportHeight
  );

  // Wave contribution
  let waveResult = calculateWaves(worldPos, params.time);
  let waveHeight = waveResult.x;
  let waveDhdt = waveResult.w;

  // Modifier contribution (wake effects) - returns (height, velX, velY)
  let modifierResult = calculateModifiers(worldPos.x, worldPos.y);
  let modifierHeight = modifierResult.x;
  let modifierVelX = modifierResult.y;
  let modifierVelY = modifierResult.z;

  // Combined output
  let totalHeight = waveHeight + modifierHeight;
  let normalizedHeight = totalHeight / 5.0 + 0.5;
  let normalizedDhdt = waveDhdt / 10.0 + 0.5;
  let normalizedVelX = modifierVelX / 10.0 + 0.5;
  let normalizedVelY = modifierVelY / 10.0 + 0.5;

  textureStore(outputTexture, vec2<i32>(globalId.xy), vec4<f32>(normalizedHeight, normalizedDhdt, normalizedVelX, normalizedVelY));
}
`;

/**
 * Unified water state compute shader.
 *
 * This class owns the compute pipeline and provides the bind group layout.
 * Callers create their own bind groups and output textures.
 */
export class WaterStateCompute {
  private pipeline: GPUComputePipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;

  /**
   * Initialize the compute pipeline.
   */
  async init(): Promise<void> {
    const device = getWebGPU().device;

    const shaderModule = device.createShaderModule({
      code: WATER_STATE_SHADER,
      label: "Water State Compute Shader",
    });

    // Create bind group layout
    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: "write-only",
            format: "rgba32float",
            viewDimension: "2d",
          },
        },
      ],
      label: "Water State Bind Group Layout",
    });

    // Create compute pipeline
    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
      label: "Water State Pipeline Layout",
    });

    this.pipeline = device.createComputePipeline({
      layout: pipelineLayout,
      compute: {
        module: shaderModule,
        entryPoint: "main",
      },
      label: "Water State Compute Pipeline",
    });
  }

  /**
   * Get the bind group layout for creating bind groups.
   */
  getBindGroupLayout(): GPUBindGroupLayout {
    if (!this.bindGroupLayout) {
      throw new Error("WaterStateCompute not initialized");
    }
    return this.bindGroupLayout;
  }

  /**
   * Get the compute pipeline.
   */
  getPipeline(): GPUComputePipeline {
    if (!this.pipeline) {
      throw new Error("WaterStateCompute not initialized");
    }
    return this.pipeline;
  }

  /**
   * Dispatch the compute shader.
   *
   * @param computePass - The compute pass to dispatch on
   * @param bindGroup - Bind group with buffers and output texture
   * @param textureSize - Size of the output texture
   */
  dispatch(
    computePass: GPUComputePassEncoder,
    bindGroup: GPUBindGroup,
    textureSize: number,
  ): void {
    if (!this.pipeline) {
      console.warn("WaterStateCompute not initialized");
      return;
    }

    computePass.setPipeline(this.pipeline);
    computePass.setBindGroup(0, bindGroup);

    const workgroupsX = Math.ceil(textureSize / 8);
    const workgroupsY = Math.ceil(textureSize / 8);
    computePass.dispatchWorkgroups(workgroupsX, workgroupsY);
  }

  /**
   * Clean up resources.
   */
  destroy(): void {
    this.pipeline = null;
    this.bindGroupLayout = null;
  }
}
