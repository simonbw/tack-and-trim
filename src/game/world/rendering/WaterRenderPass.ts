import { ComputeShader } from "../../../core/graphics/webgpu/ComputeShader";
import type { BindingsDefinition } from "../../../core/graphics/webgpu/ShaderBindings";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import type { TerrainSystem } from "../terrain/TerrainSystem";
import type { WaterSystem } from "../water/WaterSystem";
import type { RenderRect } from "./SurfaceRenderer";

/**
 * Bindings for water rendering compute shader
 */
const WaterRenderBindings = {
  /** Wave source data */
  waveSources: { type: "storage" },
  /** Water params (time, waveCount, tideHeight) */
  waterParams: { type: "uniform" },
  /** Shadow textures (one per wave) */
  shadowTextures: { type: "texture", viewDimension: "2d-array" },
  /** Shadow sampler */
  shadowSampler: { type: "sampler" },
  /** Water modifiers */
  modifiers: { type: "storage" },
  /** Modifier params (count) */
  modifierParams: { type: "uniform" },
  /** Terrain texture for depth sampling */
  terrainTexture: { type: "texture", viewDimension: "2d" },
  /** Terrain sampler */
  terrainSampler: { type: "sampler" },
  /** Output texture (rgba16float: height, normalX, normalY, foam) */
  output: { type: "storageTexture", format: "rgba16float" },
  /** Render parameters */
  params: { type: "uniform" },
} as const satisfies BindingsDefinition;

/**
 * WGSL compute shader for water rendering.
 * Evaluates Gerstner waves with shadows, depth effects, and modifiers.
 */
const WATER_RENDER_SHADER = /* wgsl */ `

// ============================================================================
// Structs and Bindings
// ============================================================================

struct WaveSource {
  direction: vec2f,
  amplitude: f32,
  k: f32,
  omega: f32,
  _padding: vec3f,
}

struct WaterParams {
  time: f32,
  waveCount: f32,
  tideHeight: f32,
  _padding: f32,
}

struct WaterModifier {
  modifierType: f32,
  boundsMinX: f32,
  boundsMinY: f32,
  boundsMaxX: f32,
  boundsMaxY: f32,
  param0: f32,
  param1: f32,
  param2: f32,
}

struct ModifierParams {
  modifierCount: u32,
  _padding: vec3u,
}

struct RenderParams {
  renderX: f32,
  renderY: f32,
  renderWidth: f32,
  renderHeight: f32,
  outputWidth: f32,
  outputHeight: f32,
  _padding0: f32,
  _padding1: f32,
}

@group(0) @binding(0) var<storage, read> waveSources: array<WaveSource>;
@group(0) @binding(1) var<uniform> waterParams: WaterParams;
@group(0) @binding(2) var shadowTextures: texture_2d_array<f32>;
@group(0) @binding(3) var shadowSampler: sampler;
@group(0) @binding(4) var<storage, read> modifiers: array<WaterModifier>;
@group(0) @binding(5) var<uniform> modifierParams: ModifierParams;
@group(0) @binding(6) var terrainTexture: texture_2d<f32>;
@group(0) @binding(7) var terrainSampler: sampler;
@group(0) @binding(8) var output: texture_storage_2d<rgba16float, write>;
@group(0) @binding(9) var<uniform> params: RenderParams;

// ============================================================================
// Utility Functions (from WaterComputeShader)
// ============================================================================

fn computeDepthModifier(depth: f32, k: f32) -> f32 {
  let safeDepth = max(depth, 0.1);
  let refDepth = 100.0;
  let shoaling = pow(refDepth / safeDepth, 0.25);
  let dampingThreshold = 2.0;
  let damping = select(1.0, safeDepth / dampingThreshold, safeDepth < dampingThreshold);
  return shoaling * damping;
}

fn sampleShadow(worldPos: vec2f, waveIndex: u32, tileSize: f32) -> f32 {
  let tileCoord = worldPos / tileSize;
  let shadowSample = textureSampleLevel(
    shadowTextures,
    shadowSampler,
    fract(tileCoord),
    i32(waveIndex),
    0.0
  );
  return shadowSample.r;
}

fn evaluateModifier(modifier: WaterModifier, pos: vec2f, time: f32) -> f32 {
  // Bounds culling
  if (pos.x < modifier.boundsMinX || pos.x > modifier.boundsMaxX ||
      pos.y < modifier.boundsMinY || pos.y > modifier.boundsMaxY) {
    return 0.0;
  }

  let modType = u32(modifier.modifierType);

  // Wake modifier
  if (modType == 1u) {
    let center = vec2f((modifier.boundsMinX + modifier.boundsMaxX) * 0.5,
                       (modifier.boundsMinY + modifier.boundsMaxY) * 0.5);
    let strength = modifier.param0;
    let dist = length(pos - center);
    let maxRadius = (modifier.boundsMaxX - modifier.boundsMinX) * 0.5;
    let radialPhase = dist * 0.5 - time * 2.0;
    let falloff = 1.0 - smoothstep(0.0, maxRadius, dist);
    return strength * sin(radialPhase) * falloff;
  }

  // Obstacle modifier
  if (modType == 3u) {
    let dampingFactor = modifier.param0;
    let center = vec2f((modifier.boundsMinX + modifier.boundsMaxX) * 0.5,
                       (modifier.boundsMinY + modifier.boundsMaxY) * 0.5);
    let dist = length(pos - center);
    let maxRadius = (modifier.boundsMaxX - modifier.boundsMinX) * 0.5;
    let falloff = 1.0 - smoothstep(0.0, maxRadius, dist);
    return -dampingFactor * falloff * 0.1;
  }

  return 0.0;
}

fn gerstnerDisplacement(wave: WaveSource, pos: vec2f, time: f32) -> vec2f {
  let phase = wave.k * dot(pos, wave.direction) - wave.omega * time;
  let displacementMag = (wave.amplitude / wave.k) * cos(phase);
  return wave.direction * displacementMag;
}

fn evaluateWave(wave: WaveSource, pos: vec2f, time: f32) -> vec2f {
  let phase = wave.k * dot(pos, wave.direction) - wave.omega * time;
  return vec2f(
    wave.amplitude * sin(phase),
    -wave.amplitude * wave.omega * cos(phase)
  );
}

fn heightAt(pos: vec2f, time: f32) -> f32 {
  var totalHeight = 0.0;
  let count = u32(waterParams.waveCount);
  for (var i = 0u; i < count; i++) {
    let wave = waveSources[i];
    let phase = wave.k * dot(pos, wave.direction) - wave.omega * time;
    totalHeight += wave.amplitude * sin(phase);
  }
  return totalHeight;
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

  // Compute world position for this pixel
  let u = f32(pixelX) / params.outputWidth;
  let v = f32(pixelY) / params.outputHeight;
  let worldX = params.renderX + u * params.renderWidth;
  let worldY = params.renderY + v * params.renderHeight;
  let point = vec2f(worldX, worldY);

  let time = waterParams.time;

  // Sample terrain for depth (terrain texture is rg16float: height, materialId)
  let terrainSample = textureSampleLevel(terrainTexture, terrainSampler, vec2f(u, v), 0.0);
  let terrainHeight = terrainSample.r;
  let depth = max(0.0, -terrainHeight);

  // PASS 1: Accumulate horizontal displacement
  let waveCount = u32(waterParams.waveCount);
  var displacement = vec2f(0.0);
  for (var i = 0u; i < waveCount; i++) {
    displacement += gerstnerDisplacement(waveSources[i], point, time);
  }

  let displacedPos = point + displacement;

  // PASS 2: Evaluate waves with shadows and depth
  var totalZ = 0.0;
  let tileSize = 128.0;

  for (var i = 0u; i < waveCount; i++) {
    let wave = waveSources[i];
    let shadowIntensity = sampleShadow(displacedPos, i, tileSize);
    let depthModifier = computeDepthModifier(depth, wave.k);
    let result = evaluateWave(wave, displacedPos, time);
    let shadowAttenuation = 1.0 - shadowIntensity;
    let waveContribution = result.x * depthModifier * shadowAttenuation;
    totalZ += waveContribution;
  }

  // PASS 3: Apply modifiers
  let modCount = modifierParams.modifierCount;
  var modifierHeight = 0.0;
  for (var i = 0u; i < modCount; i++) {
    modifierHeight += evaluateModifier(modifiers[i], displacedPos, time);
  }

  totalZ += modifierHeight + waterParams.tideHeight;

  // Compute surface normal using gradient
  let epsilon = 0.1;
  let gradX = (heightAt(displacedPos + vec2f(epsilon, 0.0), time) -
               heightAt(displacedPos - vec2f(epsilon, 0.0), time)) / (2.0 * epsilon);
  let gradY = (heightAt(displacedPos + vec2f(0.0, epsilon), time) -
               heightAt(displacedPos - vec2f(0.0, epsilon), time)) / (2.0 * epsilon);

  let gradVec = vec2f(-gradX, -gradY);
  let gradLength = length(gradVec);
  let normal = select(vec2f(0.0, 1.0), gradVec / gradLength, gradLength > 0.0001);

  // Compute foam (simple: based on wave height)
  let foam = smoothstep(0.0, 0.5, abs(totalZ));

  // Write to output (rgba16float: height, normalX, normalY, foam)
  textureStore(output, vec2u(pixelX, pixelY), vec4f(totalZ, normal.x, normal.y, foam));
}
`;

/**
 * WaterRenderPass: Evaluates Gerstner waves and outputs water surface data.
 */
export class WaterRenderPass extends ComputeShader<typeof WaterRenderBindings> {
  readonly code = WATER_RENDER_SHADER;
  readonly bindings = WaterRenderBindings;
  readonly workgroupSize = [8, 8] as const;

  // Reusable resources
  private paramsBuffer: GPUBuffer | null = null;
  private terrainSampler: GPUSampler | null = null;

  /**
   * Initialize GPU resources
   */
  async init(): Promise<void> {
    await super.init();

    const device = getWebGPU().device;

    // Create params buffer (8 floats)
    this.paramsBuffer = device.createBuffer({
      label: "WaterRenderPass Params",
      size: 8 * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create terrain sampler (linear filtering)
    this.terrainSampler = device.createSampler({
      label: "WaterRenderPass Terrain Sampler",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
  }

  /**
   * Render water to output texture
   */
  render(
    encoder: GPUCommandEncoder,
    outputTexture: GPUTexture,
    renderRect: RenderRect,
    waterSystem: WaterSystem,
    terrainSystem: TerrainSystem | null,
  ): void {
    if (!this.paramsBuffer || !this.terrainSampler) {
      console.warn("[WaterRenderPass] Not initialized");
      return;
    }

    // Get WaterSystem buffers
    const waveSourceBuffer = waterSystem.getWaveSourceBuffer();
    const waterParamsBuffer = waterSystem.getWaterParamsBuffer();
    const shadowTextures = waterSystem.getShadowTextures();
    const shadowSampler = waterSystem.getShadowSampler();
    const modifierBuffer = waterSystem.getModifierBuffer();
    const modifierParamsBuffer = waterSystem.getModifierParamsBuffer();

    if (
      !waveSourceBuffer ||
      !waterParamsBuffer ||
      !shadowTextures ||
      !shadowSampler ||
      !modifierBuffer ||
      !modifierParamsBuffer
    ) {
      console.warn("[WaterRenderPass] WaterSystem not fully initialized");
      return;
    }

    const device = getWebGPU().device;

    // Update params buffer
    const paramsData = new Float32Array([
      renderRect.x,
      renderRect.y,
      renderRect.width,
      renderRect.height,
      outputTexture.width,
      outputTexture.height,
      0.0, // padding
      0.0, // padding
    ]);
    device.queue.writeBuffer(this.paramsBuffer, 0, paramsData);

    // Get terrain texture (or create dummy if none)
    let terrainTextureView: GPUTextureView;
    if (terrainSystem) {
      const terrainTex = terrainSystem.getTerrainTexture();
      if (terrainTex) {
        terrainTextureView = terrainTex.createView({ dimension: "2d" });
      } else {
        // Create dummy 1x1 texture
        const dummyTerrain = this.createDummyTerrainTexture(device);
        terrainTextureView = dummyTerrain.createView();
      }
    } else {
      const dummyTerrain = this.createDummyTerrainTexture(device);
      terrainTextureView = dummyTerrain.createView();
    }

    // Create bind group
    const shadowView = shadowTextures.createView({ dimension: "2d-array" });
    const outputView = outputTexture.createView();

    const bindGroup = this.createBindGroup({
      waveSources: { buffer: waveSourceBuffer },
      waterParams: { buffer: waterParamsBuffer },
      shadowTextures: shadowView,
      shadowSampler: shadowSampler,
      modifiers: { buffer: modifierBuffer },
      modifierParams: { buffer: modifierParamsBuffer },
      terrainTexture: terrainTextureView,
      terrainSampler: this.terrainSampler,
      output: outputView,
      params: { buffer: this.paramsBuffer },
    });

    // Dispatch compute shader
    const computePass = encoder.beginComputePass({
      label: "WaterRenderPass",
    });

    this.dispatch(
      computePass,
      bindGroup,
      outputTexture.width,
      outputTexture.height,
    );

    computePass.end();
  }

  /**
   * Create dummy terrain texture for when terrain is not available
   */
  private createDummyTerrainTexture(device: GPUDevice): GPUTexture {
    const dummy = device.createTexture({
      label: "WaterRenderPass Dummy Terrain",
      size: { width: 1, height: 1 },
      format: "rg16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    // Initialize with deep water (-100m)
    const data = new Float32Array([-100.0, 0.0]);
    device.queue.writeTexture(
      { texture: dummy },
      data,
      { bytesPerRow: 8 },
      { width: 1, height: 1 },
    );

    return dummy;
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    super.destroy();

    this.paramsBuffer?.destroy();
    this.paramsBuffer = null;

    this.terrainSampler = null;
  }
}
