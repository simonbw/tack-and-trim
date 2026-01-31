import { ComputeShader } from "../../../core/graphics/webgpu/ComputeShader";
import type { BindingsDefinition } from "../../../core/graphics/webgpu/ShaderBindings";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import type { RenderRect } from "./SurfaceRenderer";

/**
 * Bindings for wetness pass compute shader
 */
const WetnessBindings = {
  /** Previous wetness texture (input) */
  previousWetness: { type: "texture", viewDimension: "2d" },
  /** Wetness sampler */
  wetnessSampler: { type: "sampler" },
  /** Water texture (rgba16float: height, normal.xy, foam) */
  waterTexture: { type: "texture", viewDimension: "2d" },
  /** Water sampler */
  waterSampler: { type: "sampler" },
  /** Output wetness texture (r32float) */
  output: { type: "storageTexture", format: "r32float" },
  /** Reprojection parameters */
  params: { type: "uniform" },
} as const satisfies BindingsDefinition;

/**
 * WGSL compute shader for wetness reprojection and decay.
 * Implements:
 * - Reprojection from previous frame (world space → UV space)
 * - Wetness logic: underwater = 1.0, else decay
 */
const WETNESS_SHADER = /* wgsl */ `

// ============================================================================
// Bindings
// ============================================================================

@group(0) @binding(0) var previousWetness: texture_2d<f32>;
@group(0) @binding(1) var wetnessSampler: sampler;
@group(0) @binding(2) var waterTexture: texture_2d<f32>;
@group(0) @binding(3) var waterSampler: sampler;
@group(0) @binding(4) var output: texture_storage_2d<r32float, write>;
@group(0) @binding(5) var<uniform> params: WetnessParams;

// ============================================================================
// Structs
// ============================================================================

struct WetnessParams {
  // Current render rect
  currX: f32,
  currY: f32,
  currWidth: f32,
  currHeight: f32,
  // Previous render rect
  prevX: f32,
  prevY: f32,
  prevWidth: f32,
  prevHeight: f32,
  // Decay parameters
  decayRate: f32,       // Wetness decay per second
  dt: f32,              // Delta time
  outputWidth: f32,
  outputHeight: f32,
}

// ============================================================================
// Main Compute Kernel
// ============================================================================

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let pixelX = globalId.x;
  let pixelY = globalId.y;

  // Bounds check
  if (pixelX >= u32(params.outputWidth) || pixelY >= u32(params.outputHeight)) {
    return;
  }

  // Compute current world position for this pixel
  let u = f32(pixelX) / params.outputWidth;
  let v = f32(pixelY) / params.outputHeight;
  let worldX = params.currX + u * params.currWidth;
  let worldY = params.currY + v * params.currHeight;

  // Sample water height at current position
  let waterSample = textureSampleLevel(waterTexture, waterSampler, vec2f(u, v), 0.0);
  let waterHeight = waterSample.r;

  // Determine if underwater (water height > 0 means water surface above terrain)
  let isUnderwater = waterHeight > 0.0;

  // Reprojection: Convert world position back to previous frame's UV
  let prevU = (worldX - params.prevX) / params.prevWidth;
  let prevV = (worldY - params.prevY) / params.prevHeight;

  // Sample previous wetness (clamp to edge if outside bounds)
  var prevWetnessValue = 0.0;
  if (prevU >= 0.0 && prevU <= 1.0 && prevV >= 0.0 && prevV <= 1.0) {
    prevWetnessValue = textureSampleLevel(previousWetness, wetnessSampler, vec2f(prevU, prevV), 0.0).r;
  }

  // Compute new wetness
  var newWetness: f32;
  if (isUnderwater) {
    // Underwater: instant full wetness
    newWetness = 1.0;
  } else {
    // Above water: decay previous wetness
    let decay = exp(-params.decayRate * params.dt);
    newWetness = prevWetnessValue * decay;
  }

  // Write to output (r32float, clamp to [0, 1])
  textureStore(output, vec2u(pixelX, pixelY), vec4f(clamp(newWetness, 0.0, 1.0), 0.0, 0.0, 0.0));
}
`;

/**
 * WetnessPass: Reprojects wetness from previous frame and applies decay.
 */
export class WetnessPass extends ComputeShader<typeof WetnessBindings> {
  readonly code = WETNESS_SHADER;
  readonly bindings = WetnessBindings;
  readonly workgroupSize = [8, 8] as const;

  // Reusable resources
  private paramsBuffer: GPUBuffer | null = null;
  private wetnessSampler: GPUSampler | null = null;
  private waterSampler: GPUSampler | null = null;

  // Timing
  private lastTime = 0;

  /**
   * Initialize GPU resources
   */
  async init(): Promise<void> {
    await super.init();

    const device = getWebGPU().device;

    // Create params buffer (12 floats)
    this.paramsBuffer = device.createBuffer({
      label: "WetnessPass Params",
      size: 12 * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create samplers (linear filtering for smooth reprojection)
    this.wetnessSampler = device.createSampler({
      label: "WetnessPass Wetness Sampler",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.waterSampler = device.createSampler({
      label: "WetnessPass Water Sampler",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.lastTime = performance.now() / 1000;
  }

  /**
   * Render wetness with reprojection
   */
  render(
    encoder: GPUCommandEncoder,
    previousWetnessTexture: GPUTexture,
    outputWetnessTexture: GPUTexture,
    waterTexture: GPUTexture,
    currentRect: RenderRect,
    previousRect: RenderRect,
  ): void {
    if (!this.paramsBuffer || !this.wetnessSampler || !this.waterSampler) {
      console.warn("[WetnessPass] Not initialized");
      return;
    }

    const device = getWebGPU().device;

    // Compute delta time
    const currentTime = performance.now() / 1000;
    const dt = Math.min(currentTime - this.lastTime, 0.1); // Clamp to 100ms max
    this.lastTime = currentTime;

    // Update params buffer
    const paramsData = new Float32Array([
      currentRect.x,
      currentRect.y,
      currentRect.width,
      currentRect.height,
      previousRect.x,
      previousRect.y,
      previousRect.width,
      previousRect.height,
      2.0, // decayRate (wetness halves every ~0.35 seconds)
      dt,
      outputWetnessTexture.width,
      outputWetnessTexture.height,
    ]);
    device.queue.writeBuffer(this.paramsBuffer, 0, paramsData);

    // Create bind group
    const previousWetnessView = previousWetnessTexture.createView();
    const waterTextureView = waterTexture.createView();
    const outputView = outputWetnessTexture.createView();

    const bindGroup = this.createBindGroup({
      previousWetness: previousWetnessView,
      wetnessSampler: this.wetnessSampler,
      waterTexture: waterTextureView,
      waterSampler: this.waterSampler,
      output: outputView,
      params: { buffer: this.paramsBuffer },
    });

    // Dispatch compute shader
    const computePass = encoder.beginComputePass({
      label: "WetnessPass",
    });

    this.dispatch(
      computePass,
      bindGroup,
      outputWetnessTexture.width,
      outputWetnessTexture.height,
    );

    computePass.end();
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    super.destroy();

    this.paramsBuffer?.destroy();
    this.paramsBuffer = null;

    this.wetnessSampler = null;
    this.waterSampler = null;
  }
}
