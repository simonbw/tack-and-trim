/**
 * WebGPU compute shader for wind modifier computation.
 *
 * Computes wind contributions from sails and turbulence particles on the GPU.
 * Sails create zone-based effects (leeward acceleration, windward blockage, wake shadow).
 * Turbulence particles add chaotic velocity variations.
 *
 * The output is added to the base wind texture to get final wind velocity.
 */

import { GPUProfiler } from "../../../core/graphics/webgpu/GPUProfiler";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import {
  LEEWARD_ACCELERATION,
  MAX_SAILS,
  MAX_TURBULENCE,
  TURBULENCE_RADIUS,
  TURBULENCE_STRENGTH,
  WAKE_LENGTH_FACTOR,
  WAKE_SHADOW_FACTOR,
  WINDWARD_BLOCKAGE,
  WIND_MIN_DISTANCE,
  WIND_MODIFIER_SCALE,
} from "../WindConstants";
import {
  FLOATS_PER_SAIL,
  FLOATS_PER_TURBULENCE,
  GPUSailData,
  GPUTurbulenceData,
  packSailData,
  packTurbulenceData,
} from "./WindModifierData";

// WGSL compute shader for wind modifier computation
const windModifierComputeShader = /*wgsl*/ `
const PI: f32 = 3.14159265359;
const MAX_SAILS: u32 = ${MAX_SAILS}u;
const MAX_TURBULENCE: u32 = ${MAX_TURBULENCE}u;

// Sail wind effect constants
const LEEWARD_ACCELERATION: f32 = ${LEEWARD_ACCELERATION};
const WINDWARD_BLOCKAGE: f32 = ${WINDWARD_BLOCKAGE};
const WAKE_SHADOW_FACTOR: f32 = ${WAKE_SHADOW_FACTOR};
const WAKE_LENGTH_FACTOR: f32 = ${WAKE_LENGTH_FACTOR};
const WIND_MIN_DISTANCE: f32 = ${WIND_MIN_DISTANCE};

// Turbulence constants
const TURBULENCE_STRENGTH: f32 = ${TURBULENCE_STRENGTH};
const TURBULENCE_RADIUS: f32 = ${TURBULENCE_RADIUS};

// Output encoding
const WIND_MODIFIER_SCALE: f32 = ${WIND_MODIFIER_SCALE};

struct Params {
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  textureSizeX: f32,
  textureSizeY: f32,
  sailCount: u32,
  turbulenceCount: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> sails: array<f32>;
@group(0) @binding(2) var<storage, read> turbulence: array<f32>;
@group(0) @binding(3) var outputTexture: texture_storage_2d<rg16float, write>;

// ============================================================================
// Sail wind contribution
// ============================================================================

fn getSailContribution(worldX: f32, worldY: f32, sailIdx: u32) -> vec2<f32> {
  let base = sailIdx * 16u;

  // Unpack sail data
  let centroidX = sails[base + 0u];
  let centroidY = sails[base + 1u];
  let chordDirX = sails[base + 2u];
  let chordDirY = sails[base + 3u];
  let normalX = sails[base + 4u];
  let normalY = sails[base + 5u];
  let chordLength = sails[base + 6u];
  let influenceRadius = sails[base + 7u];
  let windDirX = sails[base + 8u];
  let windDirY = sails[base + 9u];
  let windSpeed = sails[base + 10u];
  let liftCoeff = sails[base + 11u];
  let stallFraction = sails[base + 12u];

  // Vector from centroid to query point
  let toQueryX = worldX - centroidX;
  let toQueryY = worldY - centroidY;
  let dist = sqrt(toQueryX * toQueryX + toQueryY * toQueryY);

  // Early out if too close or too far
  if (dist < WIND_MIN_DISTANCE || dist > influenceRadius) {
    return vec2<f32>(0.0, 0.0);
  }

  let toQueryDirX = toQueryX / dist;
  let toQueryDirY = toQueryY / dist;

  // Normal component (positive = leeward side)
  let normalComponent = toQueryDirX * normalX + toQueryDirY * normalY;
  // Wind component (positive = downwind)
  let windComponent = toQueryDirX * windDirX + toQueryDirY * windDirY;

  let distanceFalloff = 1.0 - dist / influenceRadius;
  let liftStrength = abs(liftCoeff) * chordLength;

  var cx: f32 = 0.0;
  var cy: f32 = 0.0;

  // Leeward zone: accelerated flow parallel to sail
  if (normalComponent > 0.3) {
    let acceleration = LEEWARD_ACCELERATION * liftStrength * normalComponent * distanceFalloff * windSpeed;
    cx += chordDirX * acceleration;
    cy += chordDirY * acceleration;
  }
  // Windward zone: blocked flow
  else if (normalComponent < -0.3) {
    let blockage = WINDWARD_BLOCKAGE * liftStrength * abs(normalComponent) * distanceFalloff * windSpeed;
    cx -= windDirX * blockage;
    cy -= windDirY * blockage;
  }

  // Wake shadow zone
  if (windComponent > 0.5 && stallFraction > 0.0) {
    let wakeLength = chordLength * WAKE_LENGTH_FACTOR;
    let wakeDistance = dist * windComponent;

    if (wakeDistance < wakeLength) {
      let wakeFalloff = 1.0 - wakeDistance / wakeLength;
      let shadow = WAKE_SHADOW_FACTOR * stallFraction * wakeFalloff * windSpeed;
      cx -= windDirX * shadow;
      cy -= windDirY * shadow;
    }
  }

  return vec2<f32>(cx, cy);
}

// ============================================================================
// Turbulence wind contribution
// ============================================================================

// Simple seeded pseudo-random for deterministic turbulence
fn lcgRandom(seed: u32) -> f32 {
  let s = (seed * 1103515245u + 12345u);
  return f32((s >> 16u) & 0x7fffu) / 32767.0 - 0.5;
}

fn getTurbulenceContribution(worldX: f32, worldY: f32, turbIdx: u32) -> vec2<f32> {
  let base = turbIdx * 8u;

  // Unpack turbulence data
  let posX = turbulence[base + 0u];
  let posY = turbulence[base + 1u];
  let radius = turbulence[base + 2u];
  let intensity = turbulence[base + 3u];
  let seed = u32(turbulence[base + 4u]);
  let age = turbulence[base + 5u];

  let dx = worldX - posX;
  let dy = worldY - posY;
  let dist = sqrt(dx * dx + dy * dy);

  if (dist > radius || dist < 0.5) {
    return vec2<f32>(0.0, 0.0);
  }

  let falloff = 1.0 - dist / radius;

  // Generate pseudo-random direction based on seed and age
  let timeVariation = u32(floor(age * 10.0));
  let rx = lcgRandom(seed + timeVariation);
  let ry = lcgRandom(seed + timeVariation + 1u);

  let magnitude = intensity * TURBULENCE_STRENGTH * falloff;

  return vec2<f32>(rx * 2.0 * magnitude, ry * 2.0 * magnitude);
}

// ============================================================================
// Main compute kernel
// ============================================================================

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let texSize = vec2<f32>(params.textureSizeX, params.textureSizeY);

  // Check bounds
  if (f32(globalId.x) >= texSize.x || f32(globalId.y) >= texSize.y) {
    return;
  }

  // Convert texel to world position
  let u = (f32(globalId.x) + 0.5) / texSize.x;
  let v = (f32(globalId.y) + 0.5) / texSize.y;

  let worldX = params.viewportLeft + u * params.viewportWidth;
  let worldY = params.viewportTop + v * params.viewportHeight;

  // Accumulate contributions
  var totalContrib = vec2<f32>(0.0, 0.0);

  // Sum sail contributions
  for (var i: u32 = 0u; i < params.sailCount; i++) {
    totalContrib += getSailContribution(worldX, worldY, i);
  }

  // Sum turbulence contributions
  for (var i: u32 = 0u; i < params.turbulenceCount; i++) {
    totalContrib += getTurbulenceContribution(worldX, worldY, i);
  }

  // Normalize to 0-1 range (0.5 = neutral, no modification)
  let normalizedVel = totalContrib / WIND_MODIFIER_SCALE + vec2<f32>(0.5, 0.5);

  textureStore(outputTexture, vec2<i32>(globalId.xy), vec4<f32>(normalizedVel.x, normalizedVel.y, 0.0, 0.0));
}
`;

/**
 * GPU compute shader for wind modifier texture generation.
 */
export class WindModifierComputeGPU {
  private pipeline: GPUComputePipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private bindGroup: GPUBindGroup | null = null;

  private paramsBuffer: GPUBuffer | null = null;
  private sailsBuffer: GPUBuffer | null = null;
  private turbulenceBuffer: GPUBuffer | null = null;
  private outputTexture: GPUTexture | null = null;
  private outputTextureView: GPUTextureView | null = null;

  private textureSize: number;
  private sailData: Float32Array;
  private turbulenceData: Float32Array;

  constructor(textureSize: number = 256) {
    this.textureSize = textureSize;
    // Pre-allocate data buffers
    this.sailData = new Float32Array(MAX_SAILS * FLOATS_PER_SAIL);
    this.turbulenceData = new Float32Array(
      MAX_TURBULENCE * FLOATS_PER_TURBULENCE,
    );
  }

  /**
   * Initialize WebGPU resources.
   */
  async init(): Promise<void> {
    const device = getWebGPU().device;

    // Create shader module
    const shaderModule = device.createShaderModule({
      code: windModifierComputeShader,
      label: "Wind Modifier Compute Shader",
    });

    // Create params uniform buffer (32 bytes)
    this.paramsBuffer = device.createBuffer({
      size: 32, // 6 floats + 2 u32 = 32 bytes
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Wind Modifier Params Buffer",
    });

    // Create sails storage buffer
    this.sailsBuffer = device.createBuffer({
      size: this.sailData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: "Wind Sails Buffer",
    });

    // Create turbulence storage buffer
    this.turbulenceBuffer = device.createBuffer({
      size: this.turbulenceData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: "Wind Turbulence Buffer",
    });

    // Create output texture (rg16float for velocity delta)
    this.outputTexture = device.createTexture({
      size: { width: this.textureSize, height: this.textureSize },
      format: "rg16float",
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
      label: "Wind Modifier Output Texture",
    });
    this.outputTextureView = this.outputTexture.createView();

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
            format: "rg16float",
            viewDimension: "2d",
          },
        },
      ],
      label: "Wind Modifier Compute Bind Group Layout",
    });

    // Create bind group
    this.bindGroup = device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuffer } },
        { binding: 1, resource: { buffer: this.sailsBuffer } },
        { binding: 2, resource: { buffer: this.turbulenceBuffer } },
        { binding: 3, resource: this.outputTextureView },
      ],
      label: "Wind Modifier Compute Bind Group",
    });

    // Create compute pipeline
    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
      label: "Wind Modifier Compute Pipeline Layout",
    });

    this.pipeline = device.createComputePipeline({
      layout: pipelineLayout,
      compute: {
        module: shaderModule,
        entryPoint: "main",
      },
      label: "Wind Modifier Compute Pipeline",
    });
  }

  /**
   * Run the modifier computation for the given viewport and modifiers.
   */
  compute(
    viewportLeft: number,
    viewportTop: number,
    viewportWidth: number,
    viewportHeight: number,
    sails: GPUSailData[],
    turbulenceParticles: GPUTurbulenceData[],
    gpuProfiler?: GPUProfiler | null,
  ): void {
    if (
      !this.pipeline ||
      !this.bindGroup ||
      !this.paramsBuffer ||
      !this.sailsBuffer ||
      !this.turbulenceBuffer
    ) {
      console.warn("WindModifierComputeGPU not initialized");
      return;
    }

    const device = getWebGPU().device;
    const sailCount = Math.min(sails.length, MAX_SAILS);
    const turbulenceCount = Math.min(
      turbulenceParticles.length,
      MAX_TURBULENCE,
    );

    // Update params buffer
    const paramsData = new ArrayBuffer(32);
    const paramsFloats = new Float32Array(paramsData, 0, 6);
    const paramsUints = new Uint32Array(paramsData, 24, 2);

    paramsFloats[0] = viewportLeft;
    paramsFloats[1] = viewportTop;
    paramsFloats[2] = viewportWidth;
    paramsFloats[3] = viewportHeight;
    paramsFloats[4] = this.textureSize;
    paramsFloats[5] = this.textureSize;
    paramsUints[0] = sailCount;
    paramsUints[1] = turbulenceCount;

    device.queue.writeBuffer(this.paramsBuffer, 0, paramsData);

    // Update sails buffer
    for (let i = 0; i < sailCount; i++) {
      packSailData(sails[i], this.sailData, i * FLOATS_PER_SAIL);
    }
    if (sailCount > 0) {
      const sailUploadSize = sailCount * FLOATS_PER_SAIL * 4;
      device.queue.writeBuffer(
        this.sailsBuffer,
        0,
        this.sailData.buffer,
        0,
        sailUploadSize,
      );
    }

    // Update turbulence buffer
    for (let i = 0; i < turbulenceCount; i++) {
      packTurbulenceData(
        turbulenceParticles[i],
        this.turbulenceData,
        i * FLOATS_PER_TURBULENCE,
      );
    }
    if (turbulenceCount > 0) {
      const turbUploadSize = turbulenceCount * FLOATS_PER_TURBULENCE * 4;
      device.queue.writeBuffer(
        this.turbulenceBuffer,
        0,
        this.turbulenceData.buffer,
        0,
        turbUploadSize,
      );
    }

    // Create command encoder
    const commandEncoder = device.createCommandEncoder({
      label: "Wind Modifier Compute Command Encoder",
    });

    // Begin compute pass
    const computePass = commandEncoder.beginComputePass({
      label: "Wind Modifier Compute Pass",
      timestampWrites:
        gpuProfiler?.getComputeTimestampWrites("modifierCompute"),
    });

    computePass.setPipeline(this.pipeline);
    computePass.setBindGroup(0, this.bindGroup);

    // Dispatch workgroups (8x8 threads per workgroup)
    const workgroupsX = Math.ceil(this.textureSize / 8);
    const workgroupsY = Math.ceil(this.textureSize / 8);
    computePass.dispatchWorkgroups(workgroupsX, workgroupsY);

    computePass.end();

    // Submit
    device.queue.submit([commandEncoder.finish()]);
  }

  /**
   * Get the output texture for further processing.
   */
  getOutputTexture(): GPUTexture | null {
    return this.outputTexture;
  }

  /**
   * Get the output texture view for binding.
   */
  getOutputTextureView(): GPUTextureView | null {
    return this.outputTextureView;
  }

  /**
   * Get the texture size.
   */
  getTextureSize(): number {
    return this.textureSize;
  }

  /**
   * Destroy GPU resources.
   */
  destroy(): void {
    this.paramsBuffer?.destroy();
    this.sailsBuffer?.destroy();
    this.turbulenceBuffer?.destroy();
    this.outputTexture?.destroy();
    this.pipeline = null;
    this.bindGroup = null;
    this.bindGroupLayout = null;
  }
}
