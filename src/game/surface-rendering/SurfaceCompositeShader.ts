/**
 * Surface Composite Fullscreen Shader
 *
 * Final pass of the multi-pass surface rendering pipeline.
 * Reads height textures, computes normals via finite differences,
 * and renders water/terrain with full lighting.
 *
 * Inputs:
 * - Water height texture (r32float)
 * - Terrain height texture (r32float)
 * - Shadow texture (rg16float)
 *
 * Output:
 * - Final surface color with lighting
 */

import {
  FullscreenShader,
  type FullscreenShaderConfig,
} from "../../core/graphics/webgpu/FullscreenShader";
import type { ShaderModule } from "../../core/graphics/webgpu/ShaderModule";
import { fn_renderWaterLighting } from "../world/shaders/lighting.wgsl";
import { fn_renderSand } from "../world/shaders/sand-rendering.wgsl";
import { fn_hash21 } from "../world/shaders/math.wgsl";
import { fn_simplex3D } from "../world/shaders/noise.wgsl";

// Shallow water threshold for rendering
const SHALLOW_WATER_THRESHOLD = 1.5;

/**
 * Params module with uniforms and bindings for surface composite.
 */
const surfaceCompositeParamsModule: ShaderModule = {
  preamble: /*wgsl*/ `
// Surface composite parameters
struct Params {
  // Camera matrix for screen-to-world transform (3x3, stored as 3 vec4s for alignment)
  cameraMatrix0: vec4<f32>,
  cameraMatrix1: vec4<f32>,
  cameraMatrix2: vec4<f32>,

  screenWidth: f32,
  screenHeight: f32,
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  time: f32,
  tideHeight: f32,
  shallowThreshold: f32,
  hasTerrainData: i32,
  _padding0: f32,
  _padding1: f32,
}

const SHALLOW_WATER_THRESHOLD: f32 = ${SHALLOW_WATER_THRESHOLD};
`,
  bindings: {
    params: { type: "uniform", wgslType: "Params" },
    waterHeightTexture: {
      type: "texture",
      viewDimension: "2d",
      sampleType: "unfilterable-float",
    },
    terrainHeightTexture: {
      type: "texture",
      viewDimension: "2d",
      sampleType: "unfilterable-float",
    },
    shadowTexture: {
      type: "texture",
      viewDimension: "2d",
      sampleType: "float",
    },
    heightSampler: { type: "sampler", samplerType: "non-filtering" },
    shadowSampler: { type: "sampler" },
  },
  code: "",
};

/**
 * Vertex shader for fullscreen quad.
 */
const surfaceCompositeVertexModule: ShaderModule = {
  code: /*wgsl*/ `
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) clipPosition: vec2<f32>,
}

@vertex
fn vs_main(@location(0) position: vec2<f32>) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4<f32>(position, 0.0, 1.0);
  output.clipPosition = position;
  return output;
}
`,
};

/**
 * Fragment shader code for surface composite.
 */
const surfaceCompositeFragmentModule: ShaderModule = {
  dependencies: [
    surfaceCompositeVertexModule,
    surfaceCompositeParamsModule,
    fn_hash21,
    fn_simplex3D,
    fn_renderWaterLighting,
    fn_renderSand,
  ],
  code: /*wgsl*/ `
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
  // Convert clip space (-1,1) to screen coords (0, screenSize)
  let screenPos = (clipPos * 0.5 + 0.5) * vec2<f32>(params.screenWidth, params.screenHeight);

  // Transform screen position to world position using camera matrix
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

// Sample height texture at world position
fn sampleWaterHeight(worldPos: vec2<f32>) -> f32 {
  let uv = worldToHeightUV(worldPos);
  let texCoord = vec2<i32>(
    i32(uv.x * params.screenWidth),
    i32(uv.y * params.screenHeight)
  );
  return textureLoad(waterHeightTexture, texCoord, 0).r;
}

fn sampleTerrainHeight(worldPos: vec2<f32>) -> f32 {
  let uv = worldToHeightUV(worldPos);
  let texCoord = vec2<i32>(
    i32(uv.x * params.screenWidth),
    i32(uv.y * params.screenHeight)
  );
  return textureLoad(terrainHeightTexture, texCoord, 0).r;
}

// Compute normal from height texture via finite differences
fn computeWaterNormal(worldPos: vec2<f32>) -> vec3<f32> {
  let eps = params.viewportWidth / params.screenWidth * 2.0; // 2 pixel spacing

  let hL = sampleWaterHeight(worldPos + vec2<f32>(-eps, 0.0));
  let hR = sampleWaterHeight(worldPos + vec2<f32>(eps, 0.0));
  let hD = sampleWaterHeight(worldPos + vec2<f32>(0.0, -eps));
  let hU = sampleWaterHeight(worldPos + vec2<f32>(0.0, eps));

  let dx = (hR - hL) / (2.0 * eps);
  let dy = (hU - hD) / (2.0 * eps);

  return normalize(vec3<f32>(-dx, -dy, 1.0));
}

fn computeTerrainNormal(worldPos: vec2<f32>) -> vec3<f32> {
  let eps = params.viewportWidth / params.screenWidth * 2.0;

  let hL = sampleTerrainHeight(worldPos + vec2<f32>(-eps, 0.0));
  let hR = sampleTerrainHeight(worldPos + vec2<f32>(eps, 0.0));
  let hD = sampleTerrainHeight(worldPos + vec2<f32>(0.0, -eps));
  let hU = sampleTerrainHeight(worldPos + vec2<f32>(0.0, eps));

  let dx = (hR - hL) / (2.0 * eps);
  let dy = (hU - hD) / (2.0 * eps);

  return normalize(vec3<f32>(-dx, -dy, 1.0));
}

// Sample shadow texture (returns swell and chop attenuation)
fn sampleShadow(worldPos: vec2<f32>) -> vec2<f32> {
  let uv = worldToHeightUV(worldPos);
  return textureSample(shadowTexture, shadowSampler, uv).rg;
}

// Get view direction for 2D top-down view (looking down at water)
fn getViewDir() -> vec3<f32> {
  return vec3<f32>(0.0, 0.0, 1.0);
}

// Compute water color using water lighting
fn computeWaterColorAtPoint(normal: vec3<f32>, waterHeight: f32, waterDepth: f32) -> vec3<f32> {
  let viewDir = getViewDir();
  // Use water height normalized to 0-1 range (approximate based on typical wave heights)
  let rawHeight = saturate((waterHeight + 2.0) / 4.0);
  return renderWaterLighting(normal, viewDir, rawHeight, waterDepth);
}

@fragment
fn fs_main(@location(0) clipPosition: vec2<f32>) -> @location(0) vec4<f32> {
  let worldPos = clipToWorld(clipPosition);

  // Sample heights from textures
  let waterHeight = sampleWaterHeight(worldPos);
  let terrainHeight = sampleTerrainHeight(worldPos);

  // Calculate water depth
  let waterDepth = waterHeight - terrainHeight;

  // Sample shadow for visual effects
  let shadow = sampleShadow(worldPos);

  // Compute normals from height textures
  let waterNormal = computeWaterNormal(worldPos);
  let terrainNormal = computeTerrainNormal(worldPos);

  // Render based on depth
  if (params.hasTerrainData == 0) {
    // No terrain data - render as deep water
    let color = computeWaterColorAtPoint(waterNormal, waterHeight, 100.0);
    return vec4<f32>(color, 1.0);
  }

  if (waterDepth < 0.0) {
    // Above water - render as sand/terrain
    let color = renderSand(terrainHeight, terrainNormal, worldPos, 0.0);
    return vec4<f32>(color, 1.0);
  } else if (waterDepth < params.shallowThreshold) {
    // Shallow water - blend between sand and water
    let blendFactor = waterDepth / params.shallowThreshold;
    let sandColor = renderSand(terrainHeight, terrainNormal, worldPos, waterDepth);
    let waterColor = computeWaterColorAtPoint(waterNormal, waterHeight, waterDepth);
    return vec4<f32>(mix(sandColor, waterColor, blendFactor), 1.0);
  } else {
    // Deep water
    let color = computeWaterColorAtPoint(waterNormal, waterHeight, waterDepth);
    return vec4<f32>(color, 1.0);
  }
}
`,
};

const surfaceCompositeShaderConfig: FullscreenShaderConfig = {
  modules: [surfaceCompositeFragmentModule],
  label: "SurfaceCompositeShader",
};

export function createSurfaceCompositeShader(): FullscreenShader {
  return new FullscreenShader(surfaceCompositeShaderConfig);
}
