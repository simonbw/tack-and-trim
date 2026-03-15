/**
 * Terrain Gradient Debug Mode
 *
 * Visualizes the analytical terrain gradient computed by
 * computeTerrainHeightAndGradient at every screen pixel.
 * A compute shader evaluates the contour tree per pixel,
 * then a fullscreen fragment shader maps gradient direction
 * to hue and magnitude to brightness.
 */

import type { GameEventMap } from "../../../core/entity/Entity";
import { on } from "../../../core/entity/handler";
import {
  defineUniformStruct,
  f32,
  mat3x3,
  u32 as uniformU32,
  type UniformInstance,
} from "../../../core/graphics/UniformStruct";
import {
  ComputeShader,
  type ComputeShaderConfig,
} from "../../../core/graphics/webgpu/ComputeShader";
import {
  FullscreenShader,
  type FullscreenShaderConfig,
} from "../../../core/graphics/webgpu/FullscreenShader";
import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";
import { radToDeg } from "../../../core/util/MathUtil";
import { DEFAULT_DEPTH } from "../../world/terrain/TerrainConstants";
import {
  struct_ContourData,
  fn_computeTerrainHeightAndGradient,
} from "../../world/shaders/terrain.wgsl";
import { TerrainResources } from "../../world/terrain/TerrainResources";
import { TerrainQuery } from "../../world/terrain/TerrainQuery";
import { DebugRenderMode } from "./DebugRenderMode";

const WORKGROUP_SIZE = [8, 8] as const;

// --- Compute shader: evaluate gradient per pixel ---

const ComputeUniforms = defineUniformStruct("ComputeParams", {
  screenWidth: f32,
  screenHeight: f32,
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  contourCount: uniformU32,
  _padding0: uniformU32,
});

const computeParamsModule: ShaderModule = {
  preamble: /*wgsl*/ `
struct ComputeParams {
  screenWidth: f32,
  screenHeight: f32,
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  contourCount: u32,
  _padding0: u32,
}

const DEFAULT_DEPTH: f32 = ${DEFAULT_DEPTH}.0;
`,
  bindings: {
    params: { type: "uniform", wgslType: "ComputeParams" },
    packedTerrain: { type: "storage", wgslType: "array<u32>" },
    outputTexture: { type: "storageTexture", format: "rgba32float" },
  },
  code: "",
};

const computeMainModule: ShaderModule = {
  dependencies: [
    computeParamsModule,
    struct_ContourData,
    fn_computeTerrainHeightAndGradient,
  ],
  code: /*wgsl*/ `
fn pixelToWorld(pixel: vec2<u32>) -> vec2<f32> {
  let uv = vec2<f32>(
    f32(pixel.x) / params.screenWidth,
    f32(pixel.y) / params.screenHeight
  );
  return vec2<f32>(
    params.viewportLeft + uv.x * params.viewportWidth,
    params.viewportTop + uv.y * params.viewportHeight
  );
}

@compute @workgroup_size(${WORKGROUP_SIZE[0]}, ${WORKGROUP_SIZE[1]})
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let pixel = global_id.xy;
  if (pixel.x >= u32(params.screenWidth) || pixel.y >= u32(params.screenHeight)) {
    return;
  }

  let worldPos = pixelToWorld(pixel);
  let hg = computeTerrainHeightAndGradient(
    worldPos,
    &packedTerrain,
    params.contourCount,
    DEFAULT_DEPTH
  );

  textureStore(outputTexture, pixel, vec4<f32>(hg.height, hg.gradientX, hg.gradientY, 0.0));
}
`,
};

const computeShaderConfig: ComputeShaderConfig = {
  modules: [computeMainModule],
  workgroupSize: WORKGROUP_SIZE,
  label: "TerrainGradientComputeShader",
};

// --- Fullscreen fragment shader: visualize gradient texture ---

const vizParamsModule: ShaderModule = {
  preamble: /*wgsl*/ `
struct VizParams {
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
    vizParams: { type: "uniform", wgslType: "VizParams" },
    gradientTexture: { type: "texture", sampleType: "unfilterable-float" },
  },
  code: "",
};

const vizMainModule: ShaderModule = {
  dependencies: [vizParamsModule],
  code: /*wgsl*/ `
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) clipPosition: vec2<f32>,
}

@vertex
fn vs_main(@location(0) position: vec2<f32>) -> VertexOutput {
  var out: VertexOutput;
  out.position = vec4<f32>(position, 0.0, 1.0);
  out.clipPosition = position;
  return out;
}

fn getCameraMatrix() -> mat3x3<f32> {
  return mat3x3<f32>(
    vizParams.cameraMatrix0.xyz,
    vizParams.cameraMatrix1.xyz,
    vizParams.cameraMatrix2.xyz
  );
}

fn clipToWorld(clipPos: vec2<f32>) -> vec2<f32> {
  let screenPos = (clipPos * 0.5 + 0.5) * vec2<f32>(vizParams.screenWidth, vizParams.screenHeight);
  let cameraMatrix = getCameraMatrix();
  let worldPosH = cameraMatrix * vec3<f32>(screenPos, 1.0);
  return worldPosH.xy;
}

fn worldToTexCoord(worldPos: vec2<f32>) -> vec2<i32> {
  let uv = vec2<f32>(
    (worldPos.x - vizParams.viewportLeft) / vizParams.viewportWidth,
    (worldPos.y - vizParams.viewportTop) / vizParams.viewportHeight
  );
  return vec2<i32>(
    i32(uv.x * vizParams.screenWidth),
    i32(uv.y * vizParams.screenHeight)
  );
}

fn hsv2rgb(h: f32, s: f32, v: f32) -> vec3<f32> {
  let h6 = h * 6.0;
  let i = floor(h6);
  let f = h6 - i;
  let p = v * (1.0 - s);
  let q = v * (1.0 - s * f);
  let t = v * (1.0 - s * (1.0 - f));
  let sector = i32(i) % 6;
  switch (sector) {
    case 0: { return vec3<f32>(v, t, p); }
    case 1: { return vec3<f32>(q, v, p); }
    case 2: { return vec3<f32>(p, v, t); }
    case 3: { return vec3<f32>(p, q, v); }
    case 4: { return vec3<f32>(t, p, v); }
    default: { return vec3<f32>(v, p, q); }
  }
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let worldPos = clipToWorld(in.clipPosition);
  let texCoord = worldToTexCoord(worldPos);
  let data = textureLoad(gradientTexture, texCoord, 0);
  let height = data.r;
  let gx = data.g;
  let gy = data.b;

  let magnitude = sqrt(gx * gx + gy * gy);

  // Outside terrain: black
  if (height <= ${DEFAULT_DEPTH}.0 + 1.0) {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }

  // Flat areas: dark gray
  if (magnitude < 0.001) {
    return vec4<f32>(0.08, 0.08, 0.08, 1.0);
  }

  // Direction as hue, magnitude as brightness
  let angle = atan2(gy, gx);
  let hue = (angle / (2.0 * 3.14159265) + 1.0) % 1.0;
  let brightness = clamp(magnitude * 1.5, 0.15, 1.0);

  let color = hsv2rgb(hue, 0.85, brightness);
  return vec4<f32>(color, 1.0);
}
`,
};

const VizUniforms = defineUniformStruct("VizParams", {
  cameraMatrix: mat3x3,
  screenWidth: f32,
  screenHeight: f32,
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
});

const vizShaderConfig: FullscreenShaderConfig = {
  modules: [vizMainModule],
  label: "TerrainGradientVizShader",
};

// Margin for render viewport expansion (must match SurfaceRenderer)
const RENDER_VIEWPORT_MARGIN = 0.1;

// Convert radians to compass direction
function radiansToCompass(radians: number): string {
  const normalized = ((radians % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const degrees = (normalized * 180) / Math.PI;
  const compassDeg = (degrees + 90) % 360;
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const index = Math.round(compassDeg / 45) % 8;
  return directions[index];
}

function radiansToCompassBearingDeg(radians: number): number {
  const normalized = ((radians % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const degrees = (normalized * 180) / Math.PI;
  return (degrees + 90) % 360;
}

export class TerrainGradientDebugMode extends DebugRenderMode {
  layer = "windViz" as const;

  // Compute pass
  private computeShader: ComputeShader | null = null;
  private computeUniformBuffer: GPUBuffer | null = null;
  private computeUniforms: UniformInstance<
    typeof ComputeUniforms.fields
  > | null = null;
  private computeBindGroup: GPUBindGroup | null = null;

  // Gradient texture (output of compute, input to viz)
  private gradientTexture: GPUTexture | null = null;
  private gradientTextureView: GPUTextureView | null = null;
  private lastTextureWidth = 0;
  private lastTextureHeight = 0;

  // Viz pass
  private vizShader: FullscreenShader | null = null;
  private vizUniformBuffer: GPUBuffer | null = null;
  private vizUniforms: UniformInstance<typeof VizUniforms.fields> | null = null;
  private vizBindGroup: GPUBindGroup | null = null;

  private initialized = false;
  private lastTerrainBuffer: GPUBuffer | null = null;

  // Terrain query for cursor info
  private terrainQuery: TerrainQuery;

  constructor() {
    super();
    this.terrainQuery = this.addChild(
      new TerrainQuery(() => this.getCursorQueryPoint()),
    );
  }

  private getCursorQueryPoint() {
    if (!this.game) return [];
    const mouseWorldPos = this.game.camera.toWorld(this.game.io.mousePosition);
    if (!mouseWorldPos) return [];
    return [mouseWorldPos];
  }

  @on("add")
  async onAdd() {
    await this.ensureInitialized();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    const device = this.game.getWebGPUDevice();

    // Compute shader
    this.computeShader = new ComputeShader(computeShaderConfig);
    await this.computeShader.init();

    this.computeUniformBuffer = device.createBuffer({
      size: ComputeUniforms.byteSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Terrain Gradient Compute Uniform Buffer",
    });
    this.computeUniforms = ComputeUniforms.create();

    // Viz shader
    this.vizShader = new FullscreenShader(vizShaderConfig);
    await this.vizShader.init();

    this.vizUniformBuffer = device.createBuffer({
      size: VizUniforms.byteSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Terrain Gradient Viz Uniform Buffer",
    });
    this.vizUniforms = VizUniforms.create();

    this.initialized = true;
  }

  private ensureGradientTexture(width: number, height: number): void {
    if (this.lastTextureWidth === width && this.lastTextureHeight === height) {
      return;
    }

    const device = this.game.getWebGPUDevice();
    this.gradientTexture?.destroy();

    this.gradientTexture = device.createTexture({
      size: { width, height },
      format: "rgba32float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      label: "Terrain Gradient Debug Texture",
    });
    this.gradientTextureView = this.gradientTexture.createView();

    this.lastTextureWidth = width;
    this.lastTextureHeight = height;

    // Force bind group recreation
    this.computeBindGroup = null;
    this.vizBindGroup = null;
  }

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
    if (
      !this.initialized ||
      !this.computeShader ||
      !this.computeUniforms ||
      !this.vizShader ||
      !this.vizUniforms
    )
      return;

    const terrainResources =
      this.game.entities.tryGetSingleton(TerrainResources);
    if (!terrainResources) return;

    const renderer = this.game.getRenderer();
    const device = this.game.getWebGPUDevice();
    const renderPass = renderer.getCurrentRenderPass();
    if (!renderPass) return;

    const width = renderer.getWidth();
    const height = renderer.getHeight();
    const expandedViewport = this.getExpandedViewport(RENDER_VIEWPORT_MARGIN);

    this.ensureGradientTexture(width, height);

    // Rebuild bind groups if terrain buffer changed
    const terrainBuffer = terrainResources.packedTerrainBuffer;
    if (
      !this.computeBindGroup ||
      !this.vizBindGroup ||
      this.lastTerrainBuffer !== terrainBuffer
    ) {
      this.computeBindGroup = this.computeShader.createBindGroup({
        params: { buffer: this.computeUniformBuffer! },
        packedTerrain: { buffer: terrainBuffer },
        outputTexture: this.gradientTextureView!,
      });
      this.vizBindGroup = this.vizShader.createBindGroup({
        vizParams: { buffer: this.vizUniformBuffer! },
        gradientTexture: this.gradientTextureView!,
      });
      this.lastTerrainBuffer = terrainBuffer;
    }

    // Update compute uniforms
    this.computeUniforms.set.screenWidth(width);
    this.computeUniforms.set.screenHeight(height);
    this.computeUniforms.set.viewportLeft(expandedViewport.left);
    this.computeUniforms.set.viewportTop(expandedViewport.top);
    this.computeUniforms.set.viewportWidth(expandedViewport.width);
    this.computeUniforms.set.viewportHeight(expandedViewport.height);
    this.computeUniforms.set.contourCount(terrainResources.getContourCount());
    this.computeUniforms.uploadTo(this.computeUniformBuffer!);

    // Run compute pass
    const commandEncoder = device.createCommandEncoder({
      label: "Terrain Gradient Debug Compute",
    });
    const computePass = commandEncoder.beginComputePass({
      label: "Terrain Gradient Debug Compute Pass",
    });
    this.computeShader.dispatch(
      computePass,
      this.computeBindGroup,
      width,
      height,
    );
    computePass.end();
    device.queue.submit([commandEncoder.finish()]);

    // Update viz uniforms
    const cameraMatrix = this.game.camera.getMatrix().clone().invert();
    this.vizUniforms.set.cameraMatrix(cameraMatrix);
    this.vizUniforms.set.screenWidth(width);
    this.vizUniforms.set.screenHeight(height);
    this.vizUniforms.set.viewportLeft(expandedViewport.left);
    this.vizUniforms.set.viewportTop(expandedViewport.top);
    this.vizUniforms.set.viewportWidth(expandedViewport.width);
    this.vizUniforms.set.viewportHeight(expandedViewport.height);
    this.vizUniforms.uploadTo(this.vizUniformBuffer!);

    // Render visualization
    this.vizShader.render(renderPass, this.vizBindGroup);
  }

  @on("destroy")
  onDestroy(): void {
    this.computeShader?.destroy();
    this.vizShader?.destroy();
    this.computeUniformBuffer?.destroy();
    this.vizUniformBuffer?.destroy();
    this.gradientTexture?.destroy();
  }

  getModeName(): string {
    return "Terrain Gradient";
  }

  getHudInfo(): string | null {
    return "Analytical gradient from contour tree\nHue = downhill direction, Brightness = steepness\nDark = flat, Black = outside terrain";
  }

  getCursorInfo(): string | null {
    const mouseWorldPos = this.game.camera.toWorld(this.game.io.mousePosition);
    if (!mouseWorldPos) return null;

    if (this.terrainQuery.length === 0) return null;

    const result = this.terrainQuery.get(0);
    const height = result.height;
    const normal = result.normal;
    const horizontalComponent = Math.hypot(normal.x, normal.y);
    const nz = Math.sqrt(
      Math.max(0, 1 - horizontalComponent * horizontalComponent),
    );

    const slopeAngleDeg = radToDeg(Math.atan2(horizontalComponent, nz));
    const gradePercent =
      nz > 1e-5 ? (horizontalComponent / nz) * 100 : Number.POSITIVE_INFINITY;
    const gradeText = Number.isFinite(gradePercent)
      ? `${gradePercent.toFixed(1)}% grade`
      : "~vertical";

    if (horizontalComponent < 1e-4) {
      return `Terrain Height: ${height.toFixed(1)} ft\nSteepness: ${slopeAngleDeg.toFixed(1)}° (${gradeText})\nDownhill: Flat`;
    }

    const downhillAngle = Math.atan2(normal.y, normal.x);
    const downhillCompass = radiansToCompass(downhillAngle);
    const downhillBearingDeg = radiansToCompassBearingDeg(downhillAngle);

    return `Terrain Height: ${height.toFixed(1)} ft\nSteepness: ${slopeAngleDeg.toFixed(1)}° (${gradeText})\nDownhill: ${downhillCompass} (${downhillBearingDeg.toFixed(0)}°)`;
  }
}
