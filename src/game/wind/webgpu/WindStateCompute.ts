/**
 * Wind state compute shader.
 *
 * This class owns the compute pipeline and provides the bind group layout.
 * Callers (WindTileCompute instances) create their own bind groups and output textures.
 *
 * Implements base wind velocity with simplex noise variation.
 *
 * Output format (rg32float):
 * - R: Normalized velocity X (velocityX / WIND_VELOCITY_SCALE + 0.5)
 * - G: Normalized velocity Y (velocityY / WIND_VELOCITY_SCALE + 0.5)
 */

import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import {
  WIND_ANGLE_VARIATION,
  WIND_NOISE_SPATIAL_SCALE,
  WIND_NOISE_TIME_SCALE,
  WIND_SPEED_VARIATION,
  WIND_VELOCITY_SCALE,
} from "../WindConstants";

/**
 * WGSL compute shader for wind computation.
 */
export const WIND_STATE_SHADER = /*wgsl*/ `
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
@group(0) @binding(1) var outputTexture: texture_storage_2d<rg32float, write>;

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
  let normalizedVel = velocity / WIND_VELOCITY_SCALE + vec2<f32>(0.5, 0.5);

  textureStore(outputTexture, vec2<i32>(globalId.xy), vec4<f32>(normalizedVel.x, normalizedVel.y, 0.0, 0.0));
}
`;

/**
 * Wind state compute shader.
 *
 * This class owns the compute pipeline and provides the bind group layout.
 * Callers create their own bind groups and output textures.
 */
export class WindStateCompute {
  private pipeline: GPUComputePipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;

  /**
   * Initialize the compute pipeline.
   */
  async init(): Promise<void> {
    const device = getWebGPU().device;

    const shaderModule = device.createShaderModule({
      code: WIND_STATE_SHADER,
      label: "Wind State Compute Shader",
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
          storageTexture: {
            access: "write-only",
            format: "rg32float",
            viewDimension: "2d",
          },
        },
      ],
      label: "Wind State Bind Group Layout",
    });

    // Create compute pipeline
    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
      label: "Wind State Pipeline Layout",
    });

    this.pipeline = device.createComputePipeline({
      layout: pipelineLayout,
      compute: {
        module: shaderModule,
        entryPoint: "main",
      },
      label: "Wind State Compute Pipeline",
    });
  }

  /**
   * Get the bind group layout for creating bind groups.
   */
  getBindGroupLayout(): GPUBindGroupLayout {
    if (!this.bindGroupLayout) {
      throw new Error("WindStateCompute not initialized");
    }
    return this.bindGroupLayout;
  }

  /**
   * Get the compute pipeline.
   */
  getPipeline(): GPUComputePipeline {
    if (!this.pipeline) {
      throw new Error("WindStateCompute not initialized");
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
      console.warn("WindStateCompute not initialized");
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
