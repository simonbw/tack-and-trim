/**
 * WebGPU compute shader for wake modifier computation.
 *
 * Computes wake contributions from capsule segments on the GPU,
 * replacing the expensive CPU-based per-texel sampling.
 *
 * Each wake particle is represented as a capsule segment (or circle for tail particles).
 * The shader computes the height contribution from all segments for each texel in parallel.
 */

import { GPUProfiler } from "../../../core/graphics/webgpu/GPUProfiler";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";

// Constants matching WakeParticle.ts
const HEIGHT_SCALE = 0.5;
const OUTPUT_SCALE = 0.2; // Matches old ModifierDataTexture (1/5.0)

// Maximum number of wake segments we can process
const MAX_SEGMENTS = 256;
const FLOATS_PER_SEGMENT = 8; // startX, startY, endX, endY, startRadius, endRadius, startIntensity, endIntensity

// WGSL compute shader for modifier computation
const modifierComputeShader = /*wgsl*/ `
const PI: f32 = 3.14159265359;
const HEIGHT_SCALE: f32 = ${HEIGHT_SCALE};
const OUTPUT_SCALE: f32 = ${OUTPUT_SCALE};
const MAX_SEGMENTS: u32 = ${MAX_SEGMENTS}u;

struct Params {
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  textureSizeX: f32,
  textureSizeY: f32,
  segmentCount: u32,
  _padding: u32,
}

// Each segment is 8 floats: startX, startY, endX, endY, startRadius, endRadius, startIntensity, endIntensity
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> segments: array<f32>;
@group(0) @binding(2) var outputTexture: texture_storage_2d<rgba8unorm, write>;

fn getSegmentContribution(worldX: f32, worldY: f32, segmentIndex: u32) -> f32 {
  let base = segmentIndex * 8u;

  let startX = segments[base + 0u];
  let startY = segments[base + 1u];
  let endX = segments[base + 2u];
  let endY = segments[base + 3u];
  let startRadius = segments[base + 4u];
  let endRadius = segments[base + 5u];
  let startIntensity = segments[base + 6u];
  let endIntensity = segments[base + 7u];

  // Segment vector
  let segX = endX - startX;
  let segY = endY - startY;
  let segLenSq = segX * segX + segY * segY;

  // Handle degenerate case (circle) - when start == end or very close
  if (segLenSq < 0.001) {
    // Circular contribution
    let dx = worldX - startX;
    let dy = worldY - startY;
    let distSq = dx * dx + dy * dy;
    let radiusSq = startRadius * startRadius;

    if (distSq >= radiusSq) {
      return 0.0;
    }

    let dist = sqrt(distSq);
    let t = dist / startRadius; // 0 at center, 1 at edge

    // Cosine wave profile
    let waveProfile = cos(t * PI) * (1.0 - t);
    return waveProfile * startIntensity * HEIGHT_SCALE;
  }

  // Segment contribution - project query point onto segment
  let toQueryX = worldX - startX;
  let toQueryY = worldY - startY;

  // t = 0 at start, 1 at end
  let t = clamp((toQueryX * segX + toQueryY * segY) / segLenSq, 0.0, 1.0);

  // Closest point on segment
  let closestX = startX + t * segX;
  let closestY = startY + t * segY;

  // Perpendicular distance
  let perpDx = worldX - closestX;
  let perpDy = worldY - closestY;
  let perpDistSq = perpDx * perpDx + perpDy * perpDy;

  // Interpolate radius along segment
  let radius = startRadius + t * (endRadius - startRadius);
  let radiusSq = radius * radius;

  if (perpDistSq >= radiusSq) {
    return 0.0;
  }

  let perpDist = sqrt(perpDistSq);
  let normalizedDist = perpDist / radius; // 0 at center, 1 at edge

  // Interpolate intensity along segment
  let intensity = startIntensity + t * (endIntensity - startIntensity);

  // Cosine wave profile
  let waveProfile = cos(normalizedDist * PI) * (1.0 - normalizedDist);
  return waveProfile * intensity * HEIGHT_SCALE;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let texSize = vec2<f32>(params.textureSizeX, params.textureSizeY);

  // Check bounds
  if (f32(globalId.x) >= texSize.x || f32(globalId.y) >= texSize.y) {
    return;
  }

  // Convert texel to world position (sample at texel center)
  let u = (f32(globalId.x) + 0.5) / texSize.x;
  let v = (f32(globalId.y) + 0.5) / texSize.y;

  let worldX = params.viewportLeft + u * params.viewportWidth;
  let worldY = params.viewportTop + v * params.viewportHeight;

  // Accumulate height contribution from all segments
  var totalHeight: f32 = 0.0;

  for (var i: u32 = 0u; i < params.segmentCount; i++) {
    totalHeight += getSegmentContribution(worldX, worldY, i);
  }

  // Convert to normalized output (0.5 = neutral, matching CPU implementation)
  // currentHeight starts at 0.5, we add totalHeight * OUTPUT_SCALE
  let normalizedHeight = clamp(0.5 + totalHeight * OUTPUT_SCALE, 0.0, 1.0);

  textureStore(outputTexture, vec2<i32>(globalId.xy), vec4<f32>(normalizedHeight, 0.5, 0.5, 1.0));
}
`;

/**
 * Data for a single wake segment to be sent to GPU.
 */
export interface WakeSegmentData {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  startRadius: number;
  endRadius: number;
  startIntensity: number;
  endIntensity: number;
}

/**
 * GPU compute shader for wake modifier texture generation.
 */
export class ModifierComputeGPU {
  private pipeline: GPUComputePipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private bindGroup: GPUBindGroup | null = null;

  private paramsBuffer: GPUBuffer | null = null;
  private segmentsBuffer: GPUBuffer | null = null;
  private outputTexture: GPUTexture | null = null;
  private outputTextureView: GPUTextureView | null = null;

  private textureSize: number;
  private segmentData: Float32Array;

  constructor(textureSize: number = 512) {
    this.textureSize = textureSize;
    // Pre-allocate segment data buffer
    this.segmentData = new Float32Array(MAX_SEGMENTS * FLOATS_PER_SEGMENT);
  }

  /**
   * Initialize WebGPU resources.
   */
  async init(): Promise<void> {
    const device = getWebGPU().device;

    // Create shader module
    const shaderModule = device.createShaderModule({
      code: modifierComputeShader,
      label: "Modifier Compute Shader",
    });

    // Create params uniform buffer (32 bytes)
    this.paramsBuffer = device.createBuffer({
      size: 32, // 6 floats + 2 u32 = 32 bytes
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Modifier Params Buffer",
    });

    // Create segments storage buffer
    this.segmentsBuffer = device.createBuffer({
      size: this.segmentData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: "Wake Segments Buffer",
    });

    // Create output texture (rgba8unorm for modifier data)
    this.outputTexture = device.createTexture({
      size: { width: this.textureSize, height: this.textureSize },
      format: "rgba8unorm",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      label: "Modifier Output Texture",
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
          storageTexture: {
            access: "write-only",
            format: "rgba8unorm",
            viewDimension: "2d",
          },
        },
      ],
      label: "Modifier Compute Bind Group Layout",
    });

    // Create bind group
    this.bindGroup = device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuffer } },
        { binding: 1, resource: { buffer: this.segmentsBuffer } },
        { binding: 2, resource: this.outputTextureView },
      ],
      label: "Modifier Compute Bind Group",
    });

    // Create compute pipeline
    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
      label: "Modifier Compute Pipeline Layout",
    });

    this.pipeline = device.createComputePipeline({
      layout: pipelineLayout,
      compute: {
        module: shaderModule,
        entryPoint: "main",
      },
      label: "Modifier Compute Pipeline",
    });
  }

  /**
   * Run the modifier computation for the given viewport and segments.
   */
  compute(
    viewportLeft: number,
    viewportTop: number,
    viewportWidth: number,
    viewportHeight: number,
    segments: WakeSegmentData[],
    gpuProfiler?: GPUProfiler | null
  ): void {
    if (
      !this.pipeline ||
      !this.bindGroup ||
      !this.paramsBuffer ||
      !this.segmentsBuffer
    ) {
      console.warn("ModifierComputeGPU not initialized");
      return;
    }

    const device = getWebGPU().device;
    const segmentCount = Math.min(segments.length, MAX_SEGMENTS);

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
    paramsUints[0] = segmentCount;
    paramsUints[1] = 0; // padding

    device.queue.writeBuffer(this.paramsBuffer, 0, paramsData);

    // Update segments buffer
    for (let i = 0; i < segmentCount; i++) {
      const seg = segments[i];
      const base = i * FLOATS_PER_SEGMENT;
      this.segmentData[base + 0] = seg.startX;
      this.segmentData[base + 1] = seg.startY;
      this.segmentData[base + 2] = seg.endX;
      this.segmentData[base + 3] = seg.endY;
      this.segmentData[base + 4] = seg.startRadius;
      this.segmentData[base + 5] = seg.endRadius;
      this.segmentData[base + 6] = seg.startIntensity;
      this.segmentData[base + 7] = seg.endIntensity;
    }

    // Only upload the portion we need
    const uploadSize = segmentCount * FLOATS_PER_SEGMENT * 4;
    if (uploadSize > 0) {
      device.queue.writeBuffer(
        this.segmentsBuffer,
        0,
        this.segmentData.buffer,
        0,
        uploadSize
      );
    }

    // Create command encoder
    const commandEncoder = device.createCommandEncoder({
      label: "Modifier Compute Command Encoder",
    });

    // Begin compute pass
    const computePass = commandEncoder.beginComputePass({
      label: "Modifier Compute Pass",
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
   * Get the output texture for rendering.
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

  destroy(): void {
    this.paramsBuffer?.destroy();
    this.segmentsBuffer?.destroy();
    this.outputTexture?.destroy();
    this.pipeline = null;
    this.bindGroup = null;
    this.bindGroupLayout = null;
  }
}
