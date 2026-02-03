/**
 * Surface fullscreen shader for rendering water and terrain.
 *
 * Extends FullscreenShader base class for combined water/terrain surface rendering.
 * Features:
 * - Combined wave + modifier height data from unified compute shader
 * - Terrain height data for depth-based sand/water blending
 * - Surface normal calculation from height gradients
 * - Fresnel, subsurface scattering, and specular lighting
 */

import { FullscreenShader } from "../../core/graphics/webgpu/FullscreenShader";
import { WATER_HEIGHT_SCALE } from "../world-data/water/WaterConstants";
import { SurfaceUniforms } from "./SurfaceUniforms";
import { hashModule } from "../world/shaders/math.wgsl";
import { waterLightingModule } from "../world/shaders/lighting.wgsl";
import { sandRenderingModule } from "../world/shaders/sand-rendering.wgsl";
import { normalComputationModule } from "../world/shaders/normal-computation.wgsl";

// Terrain constants
const MAX_TERRAIN_HEIGHT = 20.0;

const bindings = {
  uniforms: { type: "uniform", wgslType: "Uniforms" },
  waterSampler: { type: "sampler" },
  waterDataTexture: { type: "texture" },
  terrainDataTexture: { type: "texture" },
  wetnessTexture: { type: "texture" },
} as const;

/**
 * Surface fullscreen shader for rendering water and terrain.
 * Uses FullscreenShader base class with custom vertex/fragment WGSL code.
 */
export class SurfaceShader extends FullscreenShader<typeof bindings> {
  readonly bindings = bindings;

  protected vertexModules = [];
  protected fragmentModules = [
    hashModule,
    waterLightingModule,
    sandRenderingModule,
    normalComputationModule,
  ];

  protected vertexMainCode = /*wgsl*/ `
${SurfaceUniforms.wgsl}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) clipPosition: vec2<f32>,
}

${this.buildWGSLBindings()}

@vertex
fn vs_main(@location(0) position: vec2<f32>) -> VertexOutput {
  var out: VertexOutput;
  out.position = vec4<f32>(position, 0.0, 1.0);
  out.clipPosition = position;
  return out;
}
`;

  protected fragmentMainCode = /*wgsl*/ `
// Note: Bindings declared in vertex code

const MAX_TERRAIN_HEIGHT: f32 = ${MAX_TERRAIN_HEIGHT};
const WATER_HEIGHT_SCALE: f32 = ${WATER_HEIGHT_SCALE};

// Sample terrain height with bilinear filtering
// Returns signed height: negative = underwater depth, positive = above water
// Uses textureSampleLevel to avoid uniform control flow restrictions
fn sampleTerrain(uv: vec2<f32>) -> f32 {
  let clampedUV = clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0));
  // Use textureSampleLevel with mip level 0 for bilinear filtering without control flow issues
  return textureSampleLevel(terrainDataTexture, waterSampler, clampedUV, 0.0).r;
}

// Render water with depth information (calls waterLightingModule)
fn renderWater(rawHeight: f32, normal: vec3<f32>, worldPos: vec2<f32>, waterDepth: f32) -> vec3<f32> {
  // View direction (looking straight down)
  let viewDir = vec3<f32>(0.0, 0.0, 1.0);

  // Use water lighting module
  var color = renderWaterLighting(normal, viewDir, rawHeight, waterDepth);

  // Add high-frequency noise
  let fineNoise = hash21(worldPos * 2.0) * 0.02 - 0.01;
  color = color + fineNoise;

  return color;
}

@fragment
fn fs_main(@location(0) clipPosition: vec2<f32>) -> @location(0) vec4<f32> {
  // Convert clip space (-1,1) to screen coords (0, screenSize)
  let screenPos = (clipPosition * 0.5 + 0.5) * vec2<f32>(uniforms.screenWidth, uniforms.screenHeight);

  // Transform screen position to world position using camera matrix
  let worldPosH = uniforms.cameraMatrix * vec3<f32>(screenPos, 1.0);
  let worldPos = worldPosH.xy;

  // Map world position to data texture UV coordinates
  var dataUV = (worldPos - vec2<f32>(uniforms.viewportLeft, uniforms.viewportTop)) /
               vec2<f32>(uniforms.viewportWidth, uniforms.viewportHeight);
  dataUV = clamp(dataUV, vec2<f32>(0.0), vec2<f32>(1.0));

  // Sample the unified water data texture
  // R: combined height (waves + modifiers), normalized
  // G: dh/dt, normalized
  // B, A: reserved
  let waterData = textureSample(waterDataTexture, waterSampler, dataUV);
  let rawHeight = waterData.r;

  // Sample terrain height (bilinear filtered)
  // terrainHeight is signed: negative = underwater, 0 = sea level, positive = land
  let terrainHeight = sampleTerrain(dataUV);

  // Calculate water depth (water surface height - terrain height)
  let waterSurfaceHeight = (rawHeight - 0.5) * WATER_HEIGHT_SCALE;  // Denormalize to world units
  let waterDepth = waterSurfaceHeight - terrainHeight;

  // Compute water surface normal from height gradients
  // Use separate texel sizes for non-square textures
  let waterTexelSizeX = 1.0 / uniforms.waterTexWidth;
  let waterTexelSizeY = 1.0 / uniforms.waterTexHeight;
  let waterNormal = computeNormalFromHeightField(
    dataUV,
    waterTexelSizeX,
    waterTexelSizeY,
    waterDataTexture,
    waterSampler,
    3.0
  );

  // Compute terrain surface normal from height gradients
  // Use separate texel sizes for non-square textures
  let terrainTexelSizeX = 1.0 / uniforms.terrainTexWidth;
  let terrainTexelSizeY = 1.0 / uniforms.terrainTexHeight;

  // Manual terrain normal computation (can't use module due to sampleTerrain wrapper)
  let terrainL = sampleTerrain(dataUV + vec2<f32>(-terrainTexelSizeX, 0.0));
  let terrainR = sampleTerrain(dataUV + vec2<f32>(terrainTexelSizeX, 0.0));
  let terrainD = sampleTerrain(dataUV + vec2<f32>(0.0, -terrainTexelSizeY));
  let terrainU = sampleTerrain(dataUV + vec2<f32>(0.0, terrainTexelSizeY));

  let terrainNormal = normalize(vec3<f32>(
    (terrainL - terrainR) * 0.5,
    (terrainD - terrainU) * 0.5,
    1.0
  ));

  // Blend normals: use terrain normal on land, water normal in deep water, blend in shallow
  var normal: vec3<f32>;
  if (waterDepth < 0.0) {
    normal = terrainNormal;
  } else if (waterDepth < uniforms.shallowThreshold) {
    let blendFactor = waterDepth / uniforms.shallowThreshold;
    normal = normalize(mix(terrainNormal, waterNormal, blendFactor));
  } else {
    normal = waterNormal;
  }

  // Sample wetness for sand rendering
  // Convert from render viewport UV to wetness viewport UV (wetness covers larger area)
  // Note: wetness viewport is snapped to texel grid, ensuring 1:1 texel mapping between frames
  let wetnessUV = (worldPos - vec2<f32>(uniforms.wetnessViewportLeft, uniforms.wetnessViewportTop)) /
                  vec2<f32>(uniforms.wetnessViewportWidth, uniforms.wetnessViewportHeight);

  // Apply slight blur to soften sharp wet/dry edges (5-tap cross pattern)
  let wetnessTexelSizeX = 1.0 / uniforms.wetnessTexWidth;
  let wetnessTexelSizeY = 1.0 / uniforms.wetnessTexHeight;
  let clampedUV = clamp(wetnessUV, vec2<f32>(0.0), vec2<f32>(1.0));
  let wetness = (
    textureSampleLevel(wetnessTexture, waterSampler, clampedUV, 0.0).r * 0.4 +
    textureSampleLevel(wetnessTexture, waterSampler, clampedUV + vec2<f32>(wetnessTexelSizeX, 0.0), 0.0).r * 0.15 +
    textureSampleLevel(wetnessTexture, waterSampler, clampedUV + vec2<f32>(-wetnessTexelSizeX, 0.0), 0.0).r * 0.15 +
    textureSampleLevel(wetnessTexture, waterSampler, clampedUV + vec2<f32>(0.0, wetnessTexelSizeY), 0.0).r * 0.15 +
    textureSampleLevel(wetnessTexture, waterSampler, clampedUV + vec2<f32>(0.0, -wetnessTexelSizeY), 0.0).r * 0.15
  );

  // Render based on water depth
  if (waterDepth < 0.0) {
    // Above water - render sand with wetness
    let sandColor = renderSand(terrainHeight, normal, worldPos, wetness);
    return vec4<f32>(sandColor, 1.0);
  } else if (waterDepth < uniforms.shallowThreshold) {
    // Shallow water - blend sand and water with minimum water visibility
    let rawBlend = smoothstep(0.0, uniforms.shallowThreshold, waterDepth);
    let minWaterBlend = 0.35;
    let blendFactor = mix(minWaterBlend, 1.0, rawBlend);

    let sandColor = renderSand(terrainHeight, normal, worldPos, wetness);
    let waterColor = renderWater(rawHeight, normal, worldPos, waterDepth);
    var blendedColor = mix(sandColor, waterColor, blendFactor);

    // Foam at water's edge (sharp line)
    let foamThreshold = 0.15;
    let foamIntensity = smoothstep(foamThreshold, 0.02, waterDepth);
    let foamNoise = hash21(worldPos * 5.0);
    let foam = foamIntensity * smoothstep(0.15, 0.4, foamNoise);
    let foamColor = vec3<f32>(0.95, 0.98, 1.0);
    blendedColor = mix(blendedColor, foamColor, foam * 0.7);

    return vec4<f32>(blendedColor, 1.0);
  } else {
    // Deep water
    let color = renderWater(rawHeight, normal, worldPos, waterDepth);
    return vec4<f32>(color, 1.0);
  }
}
`;
}
