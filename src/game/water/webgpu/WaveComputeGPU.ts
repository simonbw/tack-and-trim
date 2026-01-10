/**
 * WebGPU compute shader for Gerstner wave computation.
 *
 * Implements:
 * - 12 configurable wave components with planar and point-source waves
 * - Two-pass Gerstner algorithm (horizontal displacement, then height)
 * - 3D simplex noise for amplitude modulation and turbulence
 * - Direct output to storage texture (rgba16float)
 *
 * Output format:
 * - R: Normalized height (height/5.0 + 0.5)
 * - G: Normalized dh/dt (rate of height change)
 * - B, A: Reserved
 */

import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import {
  NUM_WAVES,
  GERSTNER_STEEPNESS,
  GRAVITY_FT_PER_S2,
  WAVE_AMP_MOD_SPATIAL_SCALE,
  WAVE_AMP_MOD_TIME_SCALE,
  WAVE_AMP_MOD_STRENGTH,
  buildWaveDataArray,
} from "../WaterConstants";

// WGSL compute shader for wave computation
const waveComputeShader = /*wgsl*/ `
// Constants
const PI: f32 = 3.14159265359;
const NUM_WAVES: i32 = ${NUM_WAVES};
const GERSTNER_STEEPNESS: f32 = ${GERSTNER_STEEPNESS};
const GRAVITY: f32 = ${GRAVITY_FT_PER_S2};
const WAVE_AMP_MOD_SPATIAL_SCALE: f32 = ${WAVE_AMP_MOD_SPATIAL_SCALE};
const WAVE_AMP_MOD_TIME_SCALE: f32 = ${WAVE_AMP_MOD_TIME_SCALE};
const WAVE_AMP_MOD_STRENGTH: f32 = ${WAVE_AMP_MOD_STRENGTH};

struct Params {
  time: f32,
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  textureSizeX: f32,
  textureSizeY: f32,
  _padding: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> waveData: array<f32>;
@group(0) @binding(2) var outputTexture: texture_storage_2d<rgba16float, write>;

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
// Hash function for white noise
// ============================================================================

fn hash2D(x: f32, y: f32) -> f32 {
  let n = sin(x * 127.1 + y * 311.7) * 43758.5453;
  return fract(n);
}

// ============================================================================
// Gerstner Wave Calculation
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
      // Planar wave
      dx = baseDx;
      dy = baseDy;
      let projected = x * dx + y * dy;
      phase = k * projected - omega * time + phaseOffset;
    } else {
      // Point source wave - curved wavefronts
      let sourceX = -baseDx * sourceDist + sourceOffsetX;
      let sourceY = -baseDy * sourceDist + sourceOffsetY;

      let toPointX = x - sourceX;
      let toPointY = y - sourceY;
      let distFromSource = sqrt(toPointX * toPointX + toPointY * toPointY);

      dx = toPointX / distFromSource;
      dy = toPointY / distFromSource;
      phase = k * distFromSource - omega * time + phaseOffset;
    }

    // Gerstner horizontal displacement
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
      // Planar wave
      let projected = sampleX * baseDx + sampleY * baseDy;
      phase = k * projected - omega * time + phaseOffset;
    } else {
      // Point source wave
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
    // dh/dt = -A * ampMod * omega * cos(phase)
    dhdt += -amplitude * ampMod * omega * cosPhase;
  }

  // Add surface turbulence - small non-periodic noise
  let smoothTurbulence =
    simplex3D(vec3<f32>(x * 0.15, y * 0.15, time * 0.5)) * 0.03 +
    simplex3D(vec3<f32>(x * 0.4, y * 0.4, time * 0.8)) * 0.01;

  // White noise - changes per pixel, animated slowly with time
  let timeCell = floor(time * 0.5);
  let whiteTurbulence = (hash2D(x * 0.5 + timeCell, y * 0.5) - 0.5) * 0.02;

  height += smoothTurbulence + whiteTurbulence;

  return vec4<f32>(height, dispX, dispY, dhdt);
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

  // Calculate waves
  let waveResult = calculateWaves(worldPos, params.time);
  let height = waveResult.x;
  let dhdt = waveResult.w;

  // Normalize output
  let normalizedHeight = height / 5.0 + 0.5;
  let normalizedDhdt = dhdt / 10.0 + 0.5;

  textureStore(outputTexture, vec2<i32>(globalId.xy), vec4<f32>(normalizedHeight, normalizedDhdt, 0.5, 1.0));
}
`;

/**
 * GPU compute shader wrapper for wave calculation.
 */
export class WaveComputeGPU {
  private pipeline: GPUComputePipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private bindGroup: GPUBindGroup | null = null;

  private paramsBuffer: GPUBuffer | null = null;
  private waveDataBuffer: GPUBuffer | null = null;
  private outputTexture: GPUTexture | null = null;
  private outputTextureView: GPUTextureView | null = null;

  private textureSize: number;
  private waveData: Float32Array;

  constructor(textureSize: number = 512) {
    this.textureSize = textureSize;
    this.waveData = buildWaveDataArray();
  }

  /**
   * Initialize WebGPU resources.
   */
  async init(): Promise<void> {
    const device = getWebGPU().device;

    // Create shader module
    const shaderModule = device.createShaderModule({
      code: waveComputeShader,
      label: "Wave Compute Shader",
    });

    // Create params uniform buffer (32 bytes, aligned)
    this.paramsBuffer = device.createBuffer({
      size: 32, // 8 floats * 4 bytes
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Wave Params Buffer",
    });

    // Create wave data storage buffer
    this.waveDataBuffer = device.createBuffer({
      size: this.waveData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: "Wave Data Buffer",
      mappedAtCreation: true,
    });
    new Float32Array(this.waveDataBuffer.getMappedRange()).set(this.waveData);
    this.waveDataBuffer.unmap();

    // Create output texture
    this.outputTexture = device.createTexture({
      size: { width: this.textureSize, height: this.textureSize },
      format: "rgba16float",
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
      label: "Wave Output Texture",
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
            format: "rgba16float",
            viewDimension: "2d",
          },
        },
      ],
      label: "Wave Compute Bind Group Layout",
    });

    // Create bind group
    this.bindGroup = device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuffer } },
        { binding: 1, resource: { buffer: this.waveDataBuffer } },
        { binding: 2, resource: this.outputTextureView },
      ],
      label: "Wave Compute Bind Group",
    });

    // Create compute pipeline
    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
      label: "Wave Compute Pipeline Layout",
    });

    this.pipeline = device.createComputePipeline({
      layout: pipelineLayout,
      compute: {
        module: shaderModule,
        entryPoint: "main",
      },
      label: "Wave Compute Pipeline",
    });
  }

  /**
   * Run the wave computation for the given viewport.
   */
  compute(
    time: number,
    viewportLeft: number,
    viewportTop: number,
    viewportWidth: number,
    viewportHeight: number
  ): void {
    if (!this.pipeline || !this.bindGroup || !this.paramsBuffer) {
      console.warn("WaveComputeGPU not initialized");
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
    ]);
    device.queue.writeBuffer(this.paramsBuffer, 0, paramsData.buffer);

    // Create command encoder
    const commandEncoder = device.createCommandEncoder({
      label: "Wave Compute Command Encoder",
    });

    // Begin compute pass
    const computePass = commandEncoder.beginComputePass({
      label: "Wave Compute Pass",
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

  /**
   * Read back pixel data from the output texture.
   * Used for physics queries.
   */
  async readPixels(): Promise<Float32Array> {
    if (!this.outputTexture) {
      return new Float32Array(0);
    }

    const device = getWebGPU().device;

    // Calculate bytes per row (must be multiple of 256)
    const bytesPerPixel = 8; // rgba16float = 4 * 2 bytes
    const unpaddedBytesPerRow = this.textureSize * bytesPerPixel;
    const paddedBytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;

    const bufferSize = paddedBytesPerRow * this.textureSize;
    const stagingBuffer = device.createBuffer({
      size: bufferSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      label: "Wave Readback Buffer",
    });

    const commandEncoder = device.createCommandEncoder();
    commandEncoder.copyTextureToBuffer(
      { texture: this.outputTexture },
      { buffer: stagingBuffer, bytesPerRow: paddedBytesPerRow },
      { width: this.textureSize, height: this.textureSize }
    );
    device.queue.submit([commandEncoder.finish()]);

    await stagingBuffer.mapAsync(GPUMapMode.READ);
    const mappedRange = stagingBuffer.getMappedRange();

    // Copy and unpad data
    const result = new Float32Array(this.textureSize * this.textureSize * 4);
    const paddedData = new Float32Array(mappedRange);

    for (let y = 0; y < this.textureSize; y++) {
      const srcOffset = (y * paddedBytesPerRow) / 4;
      const dstOffset = y * this.textureSize * 4;
      // For float16, we need special handling, but we're using Float32Array view
      // This is simplified - actual float16 to float32 conversion may be needed
      result.set(
        paddedData.subarray(srcOffset, srcOffset + this.textureSize * 4),
        dstOffset
      );
    }

    stagingBuffer.unmap();
    stagingBuffer.destroy();

    return result;
  }

  /**
   * Read a specific region of pixel data.
   */
  async readRegion(
    x: number,
    y: number,
    width: number,
    height: number
  ): Promise<Float32Array> {
    if (!this.outputTexture) {
      return new Float32Array(0);
    }

    const device = getWebGPU().device;

    const bytesPerPixel = 8;
    const unpaddedBytesPerRow = width * bytesPerPixel;
    const paddedBytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;

    const bufferSize = paddedBytesPerRow * height;
    const stagingBuffer = device.createBuffer({
      size: bufferSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      label: "Wave Region Readback Buffer",
    });

    const commandEncoder = device.createCommandEncoder();
    commandEncoder.copyTextureToBuffer(
      { texture: this.outputTexture, origin: { x, y } },
      { buffer: stagingBuffer, bytesPerRow: paddedBytesPerRow },
      { width, height }
    );
    device.queue.submit([commandEncoder.finish()]);

    await stagingBuffer.mapAsync(GPUMapMode.READ);
    const mappedRange = stagingBuffer.getMappedRange();

    const result = new Float32Array(width * height * 4);
    const paddedData = new Float32Array(mappedRange);

    for (let row = 0; row < height; row++) {
      const srcOffset = (row * paddedBytesPerRow) / 4;
      const dstOffset = row * width * 4;
      result.set(
        paddedData.subarray(srcOffset, srcOffset + width * 4),
        dstOffset
      );
    }

    stagingBuffer.unmap();
    stagingBuffer.destroy();

    return result;
  }

  destroy(): void {
    this.paramsBuffer?.destroy();
    this.waveDataBuffer?.destroy();
    this.outputTexture?.destroy();
    this.pipeline = null;
    this.bindGroup = null;
    this.bindGroupLayout = null;
  }
}
