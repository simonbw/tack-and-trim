/**
 * Terrain Height Debug Mode
 *
 * Visualizes the terrain height texture computed by SurfaceRenderer.
 * Uses a simple fullscreen shader that samples the pre-computed texture
 * and maps height values to a color gradient:
 * - Deep blue: Deep ocean (< -10ft)
 * - Light blue: Shallow water (-10ft to 0ft)
 * - Green: Low land (0ft to 5ft)
 * - Brown/tan: Higher elevation (> 5ft)
 */

import type { GameEventMap } from "../../../core/entity/Entity";
import { on } from "../../../core/entity/handler";
import {
  FullscreenShader,
  type FullscreenShaderConfig,
} from "../../../core/graphics/webgpu/FullscreenShader";
import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import {
  defineUniformStruct,
  f32,
  mat3x3,
  type UniformInstance,
} from "../../../core/graphics/UniformStruct";
import { SurfaceRenderer } from "../../surface-rendering/SurfaceRenderer";
import { TerrainResources } from "../../world/terrain/TerrainResources";
import { DebugRenderMode } from "./DebugRenderMode";

// Margin for render viewport expansion (must match SurfaceRenderer)
const RENDER_VIEWPORT_MARGIN = 0.1;

/**
 * Uniforms for the terrain height debug shader.
 */
const TerrainHeightDebugUniforms = defineUniformStruct("Params", {
  cameraMatrix: mat3x3,
  screenWidth: f32,
  screenHeight: f32,
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
});

/**
 * Params module with uniforms and bindings for terrain height visualization.
 */
const terrainHeightDebugParamsModule: ShaderModule = {
  preamble: /*wgsl*/ `
struct Params {
  cameraMatrix0: vec4<f32>,
  cameraMatrix1: vec4<f32>,
  cameraMatrix2: vec4<f32>,
  screenWidth: f32,
  screenHeight: f32,
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  _padding0: f32,
  _padding1: f32,
}
`,
  bindings: {
    params: { type: "uniform", wgslType: "Params" },
    heightTexture: { type: "texture", sampleType: "unfilterable-float" },
  },
  code: "",
};

/**
 * Main fullscreen shader module for terrain height visualization.
 */
const terrainHeightDebugMainModule: ShaderModule = {
  dependencies: [terrainHeightDebugParamsModule],
  code: /*wgsl*/ `
// Vertex output
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) clipPosition: vec2<f32>,
}

// Fullscreen vertex shader
@vertex
fn vs_main(@location(0) position: vec2<f32>) -> VertexOutput {
  var out: VertexOutput;
  out.position = vec4<f32>(position, 0.0, 1.0);
  out.clipPosition = position;
  return out;
}

// Get camera matrix from packed vec4s
fn getCameraMatrix() -> mat3x3<f32> {
  return mat3x3<f32>(
    params.cameraMatrix0.xyz,
    params.cameraMatrix1.xyz,
    params.cameraMatrix2.xyz
  );
}

// Convert clip position to world position using camera matrix
fn clipToWorld(clipPos: vec2<f32>) -> vec2<f32> {
  let screenPos = (clipPos * 0.5 + 0.5) * vec2<f32>(params.screenWidth, params.screenHeight);
  let cameraMatrix = getCameraMatrix();
  let worldPosH = cameraMatrix * vec3<f32>(screenPos, 1.0);
  return worldPosH.xy;
}

// Convert world position to UV for height texture sampling
fn worldToHeightUV(worldPos: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(
    (worldPos.x - params.viewportLeft) / params.viewportWidth,
    (worldPos.y - params.viewportTop) / params.viewportHeight
  );
}

// Sample terrain height at world position
fn sampleTerrainHeight(worldPos: vec2<f32>) -> f32 {
  let uv = worldToHeightUV(worldPos);
  let texCoord = vec2<i32>(
    i32(uv.x * params.screenWidth),
    i32(uv.y * params.screenHeight)
  );
  return textureLoad(heightTexture, texCoord, 0).r;
}

// Map height to grayscale (linear from dark to light)
fn heightToColor(height: f32) -> vec3<f32> {
  // Map height range [-50, 20] to [0.1, 0.9] grayscale
  let t = clamp((height + 50.0) / 70.0, 0.0, 1.0);
  let gray = mix(0.1, 0.9, t);
  return vec3<f32>(gray, gray, gray);
}

// Fragment shader
@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let worldPos = clipToWorld(in.clipPosition);
  let height = sampleTerrainHeight(worldPos);
  let color = heightToColor(height);
  return vec4<f32>(color, 1.0);
}
`,
};

const terrainHeightDebugShaderConfig: FullscreenShaderConfig = {
  modules: [terrainHeightDebugMainModule],
  label: "TerrainHeightDebugShader",
};

export class TerrainHeightDebugMode extends DebugRenderMode {
  layer = "windViz" as const;

  private shader: FullscreenShader | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private uniforms: UniformInstance<
    typeof TerrainHeightDebugUniforms.fields
  > | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private initialized = false;

  // Track texture view to detect changes
  private lastTextureView: GPUTextureView | null = null;

  // Placeholder texture for when surface renderer isn't ready
  private placeholderTexture: GPUTexture | null = null;
  private placeholderTextureView: GPUTextureView | null = null;

  @on("add")
  async onAdd() {
    await this.ensureInitialized();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    const device = getWebGPU().device;

    // Create shader
    this.shader = new FullscreenShader(terrainHeightDebugShaderConfig);
    await this.shader.init();

    // Create uniform buffer
    this.uniformBuffer = device.createBuffer({
      size: TerrainHeightDebugUniforms.byteSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Terrain Height Debug Uniform Buffer",
    });

    // Create uniform instance
    this.uniforms = TerrainHeightDebugUniforms.create();

    // Create placeholder texture (1x1 with default depth value)
    this.placeholderTexture = device.createTexture({
      size: { width: 1, height: 1 },
      format: "r32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      label: "Terrain Height Debug Placeholder",
    });
    this.placeholderTextureView = this.placeholderTexture.createView();

    // Write default depth value (-50)
    const data = new Float32Array([-50]);
    device.queue.writeTexture(
      { texture: this.placeholderTexture },
      data,
      { bytesPerRow: 4 },
      { width: 1, height: 1 },
    );

    this.initialized = true;
  }

  /**
   * Get viewport expanded by the given margin factor (matches SurfaceRenderer).
   */
  private getExpandedViewport(margin: number) {
    const worldViewport = this.game.camera.getWorldViewport();
    const marginX = worldViewport.width * margin;
    const marginY = worldViewport.height * margin;

    return {
      left: worldViewport.left - marginX,
      top: worldViewport.top - marginY,
      width: worldViewport.width + marginX * 2,
      height: worldViewport.height + marginY * 2,
    };
  }

  @on("render")
  onRender(_event: GameEventMap["render"]): void {
    if (!this.initialized || !this.shader || !this.uniforms) return;

    const renderer = this.game.getRenderer();
    const renderPass = renderer.getCurrentRenderPass();
    if (!renderPass) return;

    const width = renderer.getWidth();
    const height = renderer.getHeight();
    const expandedViewport = this.getExpandedViewport(RENDER_VIEWPORT_MARGIN);

    // Get camera matrix (inverted for screen-to-world transform)
    const cameraMatrix = this.game.camera.getMatrix().clone().invert();

    // Update uniforms
    this.uniforms.set.cameraMatrix(cameraMatrix);
    this.uniforms.set.screenWidth(width);
    this.uniforms.set.screenHeight(height);
    this.uniforms.set.viewportLeft(expandedViewport.left);
    this.uniforms.set.viewportTop(expandedViewport.top);
    this.uniforms.set.viewportWidth(expandedViewport.width);
    this.uniforms.set.viewportHeight(expandedViewport.height);

    this.uniforms.uploadTo(this.uniformBuffer!);

    // Get terrain height texture from SurfaceRenderer
    const surfaceRenderer = this.game.entities.tryGetSingleton(SurfaceRenderer);
    const textureView =
      surfaceRenderer?.getTerrainHeightTextureView() ??
      this.placeholderTextureView;

    if (!textureView) return;

    // Rebuild bind group if texture changed
    if (this.lastTextureView !== textureView) {
      this.bindGroup = this.shader.createBindGroup({
        params: { buffer: this.uniformBuffer! },
        heightTexture: textureView,
      });
      this.lastTextureView = textureView;
    }

    if (this.bindGroup) {
      this.shader.render(renderPass, this.bindGroup);
    }
  }

  @on("destroy")
  onDestroy(): void {
    this.shader?.destroy();
    this.uniformBuffer?.destroy();
    this.placeholderTexture?.destroy();
  }

  getModeName(): string {
    return "Terrain Height";
  }

  getHudInfo(): string | null {
    const terrainResources =
      this.game.entities.tryGetSingleton(TerrainResources);
    const contourCount = terrainResources?.getContourCount() ?? 0;
    return `Contours: ${contourCount}\nDark=deep (-50ft), Light=high (+20ft)`;
  }

  getCursorInfo(): string | null {
    return null;
  }
}
