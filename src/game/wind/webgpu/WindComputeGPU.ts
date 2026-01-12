/**
 * WebGPU compute shader for base wind computation.
 *
 * Implements:
 * - Base wind velocity with configurable direction and speed
 * - 3D simplex noise for spatiotemporal variation (speed and angle)
 * - Direct output to storage texture (rg16float)
 *
 * Output format:
 * - R: Normalized velocity X (velocityX / 100.0 + 0.5)
 * - G: Normalized velocity Y (velocityY / 100.0 + 0.5)
 */

import {
  GPUProfiler,
  GPUProfileSection,
} from "../../../core/graphics/webgpu/GPUProfiler";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import {
  WIND_ANGLE_VARIATION,
  WIND_NOISE_SPATIAL_SCALE,
  WIND_NOISE_TIME_SCALE,
  WIND_SPEED_VARIATION,
  WIND_VELOCITY_SCALE,
} from "../WindConstants";

// WGSL compute shader for wind computation
const windComputeShader = /*wgsl*/ `
// Constants
const PI: f32 = 3.14159265359;
const WIND_NOISE_SPATIAL_SCALE: f32 = ${WIND_NOISE_SPATIAL_SCALE};
const WIND_NOISE_TIME_SCALE: f32 = ${WIND_NOISE_TIME_SCALE};
const WIND_SPEED_VARIATION: f32 = ${WIND_SPEED_VARIATION};
const WIND_ANGLE_VARIATION: f32 = ${WIND_ANGLE_VARIATION};
const WIND_VELOCITY_SCALE: f32 = ${WIND_VELOCITY_SCALE};

struct Params {
  time: f32,
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  textureSizeX: f32,
  textureSizeY: f32,
  _padding: f32,
  // Base wind direction and speed
  baseWindX: f32,
  baseWindY: f32,
  _padding2: f32,
  _padding3: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var outputTexture: texture_storage_2d<rg16float, write>;

// ============================================================================
// Simplex 3D Noise - ported from Ashima Arts / Stefan Gustavson
// https://github.com/ashima/webgl-noise
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

  // First corner
  var i = floor(v + dot(v, C.yyy));
  let x0 = v - i + dot(i, C.xxx);

  // Other corners
  let g = step(x0.yzx, x0.xyz);
  let l = 1.0 - g;
  let i1 = min(g.xyz, l.zxy);
  let i2 = max(g.xyz, l.zxy);

  let x1 = x0 - i1 + C.xxx;
  let x2 = x0 - i2 + C.yyy;
  let x3 = x0 - D.yyy;

  // Permutations
  i = mod289_3(i);
  let p = permute(permute(permute(
      i.z + vec4<f32>(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4<f32>(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4<f32>(0.0, i1.x, i2.x, 1.0));

  // Gradients
  let n_ = 0.142857142857; // 1.0/7.0
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

  // Normalise gradients
  let norm = taylorInvSqrt(vec4<f32>(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 = p0 * norm.x;
  p1 = p1 * norm.y;
  p2 = p2 * norm.z;
  p3 = p3 * norm.w;

  // Mix final noise value
  var m = max(0.6 - vec4<f32>(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), vec4<f32>(0.0));
  m = m * m;
  return 42.0 * dot(m * m, vec4<f32>(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

// ============================================================================
// Wind calculation
// ============================================================================

fn calculateWindVelocity(worldPos: vec2<f32>, time: f32) -> vec2<f32> {
  let x = worldPos.x;
  let y = worldPos.y;

  let t = time * WIND_NOISE_TIME_SCALE;
  let sx = x * WIND_NOISE_SPATIAL_SCALE;
  let sy = y * WIND_NOISE_SPATIAL_SCALE;

  // Sample noise for speed and angle variation
  // Use offset coordinates for angle noise to get independent variation
  let speedNoise = simplex3D(vec3<f32>(sx, sy, t));
  let angleNoise = simplex3D(vec3<f32>(sx + 1000.0, sy + 1000.0, t));

  let speedScale = 1.0 + speedNoise * WIND_SPEED_VARIATION;
  let angleVariance = angleNoise * WIND_ANGLE_VARIATION;

  // Apply speed scale to base wind
  let scaledX = params.baseWindX * speedScale;
  let scaledY = params.baseWindY * speedScale;

  // Rotate by angle variance
  let cosAngle = cos(angleVariance);
  let sinAngle = sin(angleVariance);
  let velocityX = scaledX * cosAngle - scaledY * sinAngle;
  let velocityY = scaledX * sinAngle + scaledY * cosAngle;

  return vec2<f32>(velocityX, velocityY);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let texSize = vec2<f32>(params.textureSizeX, params.textureSizeY);

  // Check bounds
  if (f32(globalId.x) >= texSize.x || f32(globalId.y) >= texSize.y) {
    return;
  }

  // Convert pixel coords to UV (0-1)
  let uv = vec2<f32>(f32(globalId.x) + 0.5, f32(globalId.y) + 0.5) / texSize;

  // Map UV to world position
  let worldPos = vec2<f32>(
    params.viewportLeft + uv.x * params.viewportWidth,
    params.viewportTop + uv.y * params.viewportHeight
  );

  // Calculate wind velocity
  let velocity = calculateWindVelocity(worldPos, params.time);

  // Normalize output to 0-1 range
  // Wind velocity typically ranges -50 to +50 ft/s
  let normalizedVel = velocity / WIND_VELOCITY_SCALE + vec2<f32>(0.5, 0.5);

  textureStore(outputTexture, vec2<i32>(globalId.xy), vec4<f32>(normalizedVel.x, normalizedVel.y, 0.0, 0.0));
}
`;

/**
 * GPU compute shader wrapper for base wind calculation.
 */
export class WindComputeGPU {
  private pipeline: GPUComputePipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private bindGroup: GPUBindGroup | null = null;

  private paramsBuffer: GPUBuffer | null = null;
  private outputTexture: GPUTexture | null = null;
  private outputTextureView: GPUTextureView | null = null;

  private textureSize: number;

  constructor(textureSize: number = 256) {
    this.textureSize = textureSize;
  }

  /**
   * Initialize WebGPU resources.
   */
  async init(): Promise<void> {
    const device = getWebGPU().device;

    // Create shader module
    const shaderModule = device.createShaderModule({
      code: windComputeShader,
      label: "Wind Compute Shader",
    });

    // Create params uniform buffer (48 bytes = 12 floats, aligned to 16)
    this.paramsBuffer = device.createBuffer({
      size: 48, // 12 floats * 4 bytes
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Wind Params Buffer",
    });

    // Create output texture (rg16float - 2 channels for velocity X and Y)
    this.outputTexture = device.createTexture({
      size: { width: this.textureSize, height: this.textureSize },
      format: "rg16float",
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
      label: "Wind Output Texture",
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
          storageTexture: {
            access: "write-only",
            format: "rg16float",
            viewDimension: "2d",
          },
        },
      ],
      label: "Wind Compute Bind Group Layout",
    });

    // Create bind group
    this.bindGroup = device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuffer } },
        { binding: 1, resource: this.outputTextureView },
      ],
      label: "Wind Compute Bind Group",
    });

    // Create compute pipeline
    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
      label: "Wind Compute Pipeline Layout",
    });

    this.pipeline = device.createComputePipeline({
      layout: pipelineLayout,
      compute: {
        module: shaderModule,
        entryPoint: "main",
      },
      label: "Wind Compute Pipeline",
    });
  }

  /**
   * Run the wind computation for the given viewport.
   * @param time Current game time in seconds
   * @param viewportLeft Left edge of viewport in world units
   * @param viewportTop Top edge of viewport in world units
   * @param viewportWidth Width of viewport in world units
   * @param viewportHeight Height of viewport in world units
   * @param baseWindX Base wind velocity X component
   * @param baseWindY Base wind velocity Y component
   * @param gpuProfiler Optional profiler for timing the compute pass
   * @param section GPU profile section to use
   */
  compute(
    time: number,
    viewportLeft: number,
    viewportTop: number,
    viewportWidth: number,
    viewportHeight: number,
    baseWindX: number,
    baseWindY: number,
    gpuProfiler?: GPUProfiler | null,
    section?: GPUProfileSection,
  ): void {
    if (!this.pipeline || !this.bindGroup || !this.paramsBuffer) {
      console.warn("WindComputeGPU not initialized");
      return;
    }

    const device = getWebGPU().device;

    // Update params buffer
    const paramsData = new Float32Array([
      time,
      viewportLeft,
      viewportTop,
      viewportWidth,
      viewportHeight,
      this.textureSize,
      this.textureSize,
      0, // padding
      baseWindX,
      baseWindY,
      0, // padding2
      0, // padding3
    ]);
    device.queue.writeBuffer(this.paramsBuffer, 0, paramsData.buffer);

    // Create command encoder
    const commandEncoder = device.createCommandEncoder({
      label: "Wind Compute Command Encoder",
    });

    // Begin compute pass with optional timestamp writes
    const computePass = commandEncoder.beginComputePass({
      label: "Wind Compute Pass",
      timestampWrites:
        section && gpuProfiler
          ? gpuProfiler.getComputeTimestampWrites(section)
          : undefined,
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
   * Get the output texture for further processing or readback.
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
    this.outputTexture?.destroy();
    this.paramsBuffer?.destroy();

    this.outputTexture = null;
    this.outputTextureView = null;
    this.paramsBuffer = null;
    this.pipeline = null;
    this.bindGroupLayout = null;
    this.bindGroup = null;
  }
}
