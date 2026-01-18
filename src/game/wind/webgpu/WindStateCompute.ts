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
import { SIMPLEX_NOISE_3D_WGSL } from "../../../core/graphics/webgpu/WGSLSnippets";
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

// Simplex 3D Noise
${SIMPLEX_NOISE_3D_WGSL}

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
