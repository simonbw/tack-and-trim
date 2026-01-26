/**
 * Shared GPU shader resources for debug visualization.
 *
 * Holds the GPU shader, uniform buffer, and bind groups used by
 * DepthGridDebugMode. (WaveEnergyDebugMode is temporarily disabled
 * pending update to new texture-based shadow system.)
 */

import { FullscreenShader } from "../../core/graphics/webgpu/FullscreenShader";
import { getWebGPU } from "../../core/graphics/webgpu/WebGPUDevice";
import {
  defineUniformStruct,
  f32,
  i32,
  vec2,
  vec4,
  type UniformInstance,
} from "../../core/graphics/UniformStruct";

const bindings = {
  uniforms: { type: "uniform" },
  influenceSampler: { type: "sampler" },
  depthTexture: { type: "texture" },
} as const;

// Type-safe uniform buffer definition
const DebugUniforms = defineUniformStruct("Uniforms", {
  viewportBounds: vec4, // left, top, width, height
  depthGridOrigin: vec2,
  depthGridSize: vec2, // cellsX * cellSize, cellsY * cellSize
  mode: i32, // 1=depth
  waveComponentIndex: i32, // reserved for future use
  wavelength: f32, // reserved for future use
  _padding: f32,
});

export const UNIFORM_SIZE = DebugUniforms.byteSize;

/**
 * Debug visualization fullscreen shader.
 *
 * Renders depth grid data as a colored overlay for debugging:
 * - Mode 1: Depth grid (land/water/shoreline)
 *
 * Note: Energy heatmap mode is temporarily disabled pending update
 * to the new texture-based shadow system.
 */
class DebugVisualizationShader extends FullscreenShader<typeof bindings> {
  readonly bindings = bindings;

  readonly vertexCode = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) clipPos: vec2<f32>,
}

@vertex
fn vs_main(@location(0) pos: vec2<f32>) -> VertexOutput {
  var out: VertexOutput;
  out.position = vec4<f32>(pos, 0.0, 1.0);
  out.clipPos = pos;
  return out;
}
`;

  readonly fragmentCode = /* wgsl */ `
${DebugUniforms.wgsl}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var influenceSampler: sampler;
@group(0) @binding(2) var depthTexture: texture_2d<f32>;

const DIM_ALPHA: f32 = 0.4;
const CELL_ALPHA: f32 = 0.6;

// Colors for depth mode
const WATER_COLOR: vec3<f32> = vec3<f32>(0.2, 0.4, 0.667);
const LAND_COLOR: vec3<f32> = vec3<f32>(0.545, 0.412, 0.078);
const SHORELINE_COLOR: vec3<f32> = vec3<f32>(1.0, 0.933, 0.333);

fn worldToDepthUV(worldPos: vec2<f32>) -> vec2<f32> {
  return (worldPos - uniforms.depthGridOrigin) / uniforms.depthGridSize;
}

fn sampleDepth(worldPos: vec2<f32>) -> f32 {
  let uv = worldToDepthUV(worldPos);
  return textureSample(depthTexture, influenceSampler, uv).r;
}

fn renderDepthMode(worldPos: vec2<f32>) -> vec4<f32> {
  let depth = sampleDepth(worldPos);

  var color: vec3<f32>;
  if (abs(depth) < 1.0) {
    // Shoreline
    color = SHORELINE_COLOR;
  } else if (depth < 0.0) {
    // Water
    color = WATER_COLOR;
  } else {
    // Land
    color = LAND_COLOR;
  }

  return vec4<f32>(color, CELL_ALPHA);
}

@fragment
fn fs_main(@location(0) clipPos: vec2<f32>) -> @location(0) vec4<f32> {
  // Convert clip space (-1 to 1) to normalized screen space (0 to 1)
  let screenUV = clipPos * 0.5 + 0.5;

  // Convert to world position using viewport bounds
  let worldX = uniforms.viewportBounds.x + screenUV.x * uniforms.viewportBounds.z;
  let worldY = uniforms.viewportBounds.y + (1.0 - screenUV.y) * uniforms.viewportBounds.w;
  let worldPos = vec2<f32>(worldX, worldY);

  // Base dim overlay
  var result = vec4<f32>(0.0, 0.0, 0.0, DIM_ALPHA);

  var modeColor: vec4<f32>;
  if (uniforms.mode == 1) {
    modeColor = renderDepthMode(worldPos);
  } else {
    // Other modes not yet supported in new shadow system
    return result;
  }

  // Blend mode color over dim overlay
  let srcAlpha = modeColor.a;
  result = vec4<f32>(
    modeColor.rgb * srcAlpha + result.rgb * (1.0 - srcAlpha),
    srcAlpha + result.a * (1.0 - srcAlpha)
  );

  return result;
}
`;

  protected getBlendState(): GPUBlendState {
    return {
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
    };
  }
}

/**
 * Singleton manager for shared debug shader GPU resources.
 */
export class DebugShaderManager {
  private shader: DebugVisualizationShader | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private uniforms: UniformInstance<typeof DebugUniforms.fields> | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private initialized = false;

  // Track resource changes for bind group recreation
  private lastDepthTexture: GPUTexture | null = null;

  async init(): Promise<void> {
    if (this.initialized) return;

    const device = getWebGPU().device;

    // Create shader
    this.shader = new DebugVisualizationShader();
    await this.shader.init();

    // Create uniform buffer and instance
    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Debug Visualization Uniforms",
    });
    this.uniforms = DebugUniforms.create();

    this.initialized = true;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Update uniforms for the debug shader.
   */
  updateUniforms(
    viewport: { left: number; top: number; width: number; height: number },
    depthGridConfig: {
      originX: number;
      originY: number;
      cellsX: number;
      cellsY: number;
      cellSize: number;
    },
    mode: number,
    waveComponentIndex: number,
    wavelength: number,
  ): void {
    if (!this.uniformBuffer || !this.uniforms) return;

    // Use type-safe setters
    this.uniforms.set.viewportBounds([
      viewport.left,
      viewport.top,
      viewport.width,
      viewport.height,
    ] as const);
    this.uniforms.set.depthGridOrigin([
      depthGridConfig.originX,
      depthGridConfig.originY,
    ] as const);
    this.uniforms.set.depthGridSize([
      depthGridConfig.cellsX * depthGridConfig.cellSize,
      depthGridConfig.cellsY * depthGridConfig.cellSize,
    ] as const);
    this.uniforms.set.mode(mode);
    this.uniforms.set.waveComponentIndex(waveComponentIndex);
    this.uniforms.set.wavelength(wavelength);
    this.uniforms.set._padding(0);

    // Upload to GPU
    this.uniforms.uploadTo(this.uniformBuffer);
  }

  /**
   * Rebuild bind group with the provided resources.
   * Note: Shadow buffer parameters are ignored in the simplified version.
   */
  rebuildBindGroup(
    depthTexture: GPUTexture,
    _boundariesBuffer: GPUBuffer | null,
    _polygonsBuffer: GPUBuffer | null,
    _paramsBuffer: GPUBuffer | null,
    _coastlinePointsBuffer: GPUBuffer | null,
  ): void {
    if (!this.shader || !this.uniformBuffer) return;

    const needsRebuild =
      !this.bindGroup || this.lastDepthTexture !== depthTexture;

    if (!needsRebuild) return;

    const device = getWebGPU().device;

    // Create sampler
    const sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.bindGroup = this.shader.createBindGroup({
      uniforms: { buffer: this.uniformBuffer },
      influenceSampler: sampler,
      depthTexture: depthTexture.createView(),
    });

    this.lastDepthTexture = depthTexture;
  }

  /**
   * Render the debug shader.
   */
  render(renderPass: GPURenderPassEncoder): void {
    if (!this.shader || !this.bindGroup) return;
    this.shader.render(renderPass, this.bindGroup);
  }

  destroy(): void {
    this.shader?.destroy();
    this.uniformBuffer?.destroy();
    this.bindGroup = null;
    this.shader = null;
    this.uniformBuffer = null;
    this.lastDepthTexture = null;
    this.initialized = false;
  }
}
