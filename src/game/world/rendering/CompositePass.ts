import { FullscreenShader } from "../../../core/graphics/webgpu/FullscreenShader";
import type { BindingsDefinition } from "../../../core/graphics/webgpu/ShaderBindings";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";

/**
 * Bindings for composite pass fragment shader
 */
const CompositeBindings = {
  /** Terrain texture (rgba16float: height, material ID, unused, unused) */
  terrainTexture: { type: "texture", viewDimension: "2d" },
  /** Terrain sampler */
  terrainSampler: { type: "sampler" },
  /** Water texture (rgba16float: height, normal.xy, foam) */
  waterTexture: { type: "texture", viewDimension: "2d" },
  /** Water sampler */
  waterSampler: { type: "sampler" },
  /** Wetness texture (r32float) */
  wetnessTexture: { type: "texture", viewDimension: "2d" },
  /** Wetness sampler */
  wetnessSampler: { type: "sampler" },
} as const satisfies BindingsDefinition;

/**
 * WGSL vertex shader for fullscreen quad
 */
const COMPOSITE_VERTEX_SHADER = /* wgsl */ `

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@location(0) position: vec2f) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4f(position, 0.0, 1.0);
  // Convert clip space position [-1, 1] to UV space [0, 1]
  output.uv = position * 0.5 + 0.5;
  return output;
}
`;

/**
 * WGSL fragment shader for composite rendering
 */
const COMPOSITE_FRAGMENT_SHADER = /* wgsl */ `

@group(0) @binding(0) var terrainTexture: texture_2d<f32>;
@group(0) @binding(1) var terrainSampler: sampler;
@group(0) @binding(2) var waterTexture: texture_2d<f32>;
@group(0) @binding(3) var waterSampler: sampler;
@group(0) @binding(4) var wetnessTexture: texture_2d<f32>;
@group(0) @binding(5) var wetnessSampler: sampler;

// VertexOutput struct is defined in vertex shader

/**
 * Get terrain color by height and material ID
 */
fn getTerrainColor(height: f32, materialId: f32) -> vec3f {
  // Simple height-based coloring for MVP
  // TODO: Use material ID for proper texturing

  if (height < -50.0) {
    // Deep water (should be mostly covered by water)
    return vec3f(0.1, 0.15, 0.2);
  } else if (height < -2.0) {
    // Shallow underwater
    return vec3f(0.6, 0.55, 0.4); // Sandy
  } else if (height < 0.5) {
    // Beach/shore
    return vec3f(0.85, 0.8, 0.65);
  } else if (height < 5.0) {
    // Low grass
    return vec3f(0.4, 0.6, 0.3);
  } else if (height < 15.0) {
    // Hills
    return vec3f(0.35, 0.55, 0.25);
  } else {
    // Mountains/rocks
    return vec3f(0.5, 0.5, 0.5);
  }
}

/**
 * Get water color with depth-based variation
 */
fn getWaterColor(waterHeight: f32, depth: f32) -> vec3f {
  // Base water color
  let shallowColor = vec3f(0.3, 0.6, 0.7);
  let deepColor = vec3f(0.1, 0.3, 0.5);

  // Blend based on depth (deeper = darker)
  let depthFactor = smoothstep(0.0, 10.0, depth);
  return mix(shallowColor, deepColor, depthFactor);
}

/**
 * Simple lighting calculation
 */
fn calculateLighting(normal: vec2f, baseColor: vec3f) -> vec3f {
  // Light direction (from top-left)
  let lightDir = normalize(vec2f(1.0, 1.0));

  // Diffuse lighting (use normal for slope)
  let ndotl = max(dot(normal, lightDir), 0.0);
  let diffuse = 0.6 + 0.4 * ndotl;

  return baseColor * diffuse;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  // Sample all textures
  let terrainSample = textureSample(terrainTexture, terrainSampler, input.uv);
  let waterSample = textureSample(waterTexture, waterSampler, input.uv);
  let wetnessSample = textureSample(wetnessTexture, wetnessSampler, input.uv);

  // Unpack terrain data
  let terrainHeight = terrainSample.r;
  let materialId = terrainSample.g;

  // Unpack water data
  let waterHeight = waterSample.r;
  let waterNormal = waterSample.gb;
  let foam = waterSample.a;

  // Unpack wetness
  let wetness = wetnessSample.r;

  // Get base terrain color
  var terrainColor = getTerrainColor(terrainHeight, materialId);

  // Apply wetness darkening (wet surfaces are darker)
  terrainColor = mix(terrainColor, terrainColor * 0.6, wetness);

  // Apply simple terrain lighting (use flat normal for terrain)
  let terrainNormal = vec2f(0.0, 1.0); // Flat
  terrainColor = calculateLighting(terrainNormal, terrainColor);

  // Compute water depth (water surface above terrain)
  let depth = max(0.0, waterHeight - terrainHeight);

  // Get water color
  let waterColor = getWaterColor(waterHeight, depth);

  // Apply water lighting (use water normal)
  let litWaterColor = calculateLighting(waterNormal, waterColor);

  // Add foam highlight
  let foamColor = vec3f(1.0, 1.0, 1.0);
  let waterWithFoam = mix(litWaterColor, foamColor, foam * 0.5);

  // Blend water over terrain based on depth
  // Alpha increases with depth (deeper water = more opaque)
  let waterAlpha = smoothstep(0.0, 0.5, depth);
  let finalColor = mix(terrainColor, waterWithFoam, waterAlpha);

  // Add subtle ambient lighting
  let ambientColor = vec3f(0.2, 0.25, 0.3) * 0.1;
  let result = finalColor + ambientColor;

  return vec4f(result, 1.0);
}
`;

/**
 * CompositePass: Blends terrain, water, and wetness to screen with lighting.
 */
export class CompositePass extends FullscreenShader<typeof CompositeBindings> {
  readonly vertexCode = COMPOSITE_VERTEX_SHADER;
  readonly fragmentCode = COMPOSITE_FRAGMENT_SHADER;
  readonly bindings = CompositeBindings;

  /**
   * Use rgba8unorm to match offscreen texture format
   */
  protected getTargetFormat(): GPUTextureFormat {
    return "rgba8unorm";
  }

  /**
   * Enable alpha blending so boat shows through
   */
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

  // Reusable resources
  private terrainSampler: GPUSampler | null = null;
  private waterSampler: GPUSampler | null = null;
  private wetnessSampler: GPUSampler | null = null;

  /**
   * Initialize GPU resources
   */
  async init(): Promise<void> {
    await super.init();

    const device = getWebGPU().device;

    // Create samplers (linear filtering for smooth rendering)
    this.terrainSampler = device.createSampler({
      label: "CompositePass Terrain Sampler",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.waterSampler = device.createSampler({
      label: "CompositePass Water Sampler",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.wetnessSampler = device.createSampler({
      label: "CompositePass Wetness Sampler",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
  }

  /**
   * Render composite to screen (custom wrapper)
   */
  renderComposite(
    renderPass: GPURenderPassEncoder,
    terrainTexture: GPUTexture,
    waterTexture: GPUTexture,
    wetnessTexture: GPUTexture,
  ): void {
    if (!this.terrainSampler || !this.waterSampler || !this.wetnessSampler) {
      console.warn("[CompositePass] Not initialized");
      return;
    }

    // Create texture views
    const terrainView = terrainTexture.createView();
    const waterView = waterTexture.createView();
    const wetnessView = wetnessTexture.createView();

    // Create bind group
    const bindGroup = this.createBindGroup({
      terrainTexture: terrainView,
      terrainSampler: this.terrainSampler,
      waterTexture: waterView,
      waterSampler: this.waterSampler,
      wetnessTexture: wetnessView,
      wetnessSampler: this.wetnessSampler,
    });

    // Render fullscreen quad
    super.render(renderPass, bindGroup);
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    super.destroy();

    this.terrainSampler = null;
    this.waterSampler = null;
    this.wetnessSampler = null;
  }
}
