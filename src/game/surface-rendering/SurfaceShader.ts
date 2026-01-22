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
import { TERRAIN_TEXTURE_SIZE, WATER_TEXTURE_SIZE } from "./SurfaceRenderer";

// Terrain constants
const MAX_TERRAIN_HEIGHT = 20.0;

const bindings = {
  uniforms: { type: "uniform" },
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

  readonly vertexCode = /*wgsl*/ `
struct Uniforms {
  cameraMatrix: mat3x3<f32>,
  time: f32,
  renderMode: f32,
  screenWidth: f32,
  screenHeight: f32,
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  colorNoiseStrength: f32,
  hasTerrainData: i32,
  shallowThreshold: f32,
  _padding: f32,
  // Wetness viewport (larger than render viewport)
  wetnessViewportLeft: f32,
  wetnessViewportTop: f32,
  wetnessViewportWidth: f32,
  wetnessViewportHeight: f32,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) clipPosition: vec2<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@vertex
fn vs_main(@location(0) position: vec2<f32>) -> VertexOutput {
  var out: VertexOutput;
  out.position = vec4<f32>(position, 0.0, 1.0);
  out.clipPosition = position;
  return out;
}
`;

  readonly fragmentCode = /*wgsl*/ `
// Note: Uniforms struct and uniforms binding declared in vertex code
@group(0) @binding(1) var waterSampler: sampler;
@group(0) @binding(2) var waterDataTexture: texture_2d<f32>;
@group(0) @binding(3) var terrainDataTexture: texture_2d<f32>;
@group(0) @binding(4) var wetnessTexture: texture_2d<f32>;

const PI: f32 = 3.14159265359;
const TEXTURE_SIZE: f32 = ${WATER_TEXTURE_SIZE}.0;
const TERRAIN_TEX_SIZE: f32 = ${TERRAIN_TEXTURE_SIZE}.0;
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

// Hash function for procedural noise
fn hash21(p: vec2<f32>) -> f32 {
  var q = fract(p * vec2<f32>(234.34, 435.345));
  q = q + dot(q, q + 34.23);
  return fract(q.x * q.y);
}

// Render sand/beach surface with wetness
fn renderSand(height: f32, normal: vec3<f32>, worldPos: vec2<f32>, wetness: f32) -> vec3<f32> {
  // Dry sand - light beige
  let drySand = vec3<f32>(0.96, 0.91, 0.76);
  // Wet sand - darker tan
  let wetSand = vec3<f32>(0.76, 0.70, 0.50);

  // Non-linear blend: changes quickly at first, then slowly as it dries
  // pow(wetness, 2.5) means high wetness drops fast visually, low wetness lingers
  let visualWetness = pow(wetness, 2.5);

  return mix(drySand, wetSand, visualWetness);
}

// Render water with depth information
fn renderWater(rawHeight: f32, normal: vec3<f32>, worldPos: vec2<f32>, waterDepth: f32) -> vec3<f32> {
  // Fixed midday sun
  let sunDir = normalize(vec3<f32>(0.3, 0.2, 0.9));

  // Water colors - vary by depth
  let shallowWater = vec3<f32>(0.15, 0.55, 0.65);  // Light blue-green
  let deepWater = vec3<f32>(0.08, 0.32, 0.52);     // Darker blue
  let scatterColor = vec3<f32>(0.1, 0.45, 0.55);

  // Depth-based color (deeper = darker/more blue)
  let depthFactor = smoothstep(0.0, 10.0, waterDepth);
  var baseColor = mix(shallowWater, deepWater, depthFactor);

  // Slope-based color variation
  let sunFacing = dot(normal.xy, sunDir.xy);
  let slopeShift = mix(vec3<f32>(-0.02, -0.01, 0.02), vec3<f32>(0.02, 0.03, -0.01), sunFacing * 0.5 + 0.5);
  baseColor = baseColor + slopeShift * 0.08;

  // Troughs are darker
  let troughDarken = (1.0 - rawHeight) * 0.12;
  baseColor = baseColor * (1.0 - troughDarken);

  // Sun and sky colors
  let sunColor = vec3<f32>(1.0, 0.95, 0.85);
  let skyColor = vec3<f32>(0.5, 0.7, 0.95);

  // View direction (looking straight down)
  let viewDir = vec3<f32>(0.0, 0.0, 1.0);

  // Fresnel effect
  let facing = dot(normal, viewDir);
  let fresnel = pow(1.0 - facing, 4.0) * 0.15;

  // Subsurface scattering
  let scatter = max(dot(normal, sunDir), 0.0) * (0.5 + 0.5 * rawHeight);
  let subsurface = scatterColor * scatter * 0.1;

  // Diffuse lighting
  let diffuse = max(dot(normal, sunDir), 0.0);

  // Specular
  let reflectDir = reflect(-sunDir, normal);
  let specular = pow(max(dot(viewDir, reflectDir), 0.0), 64.0);

  // Combine lighting
  let ambient = baseColor * 0.75;
  let diffuseLight = baseColor * sunColor * diffuse * 0.15;
  let skyReflection = skyColor * fresnel * 0.1;
  let specularLight = sunColor * specular * 0.08;

  var color = ambient + subsurface + diffuseLight + skyReflection + specularLight;

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

  // Debug mode: Terrain height visualization
  // Below sea level: dark blue → light blue
  // Above sea level: dark brown → light brown
  if (uniforms.renderMode == 1.0) {
    var debugColor: vec3<f32>;
    if (terrainHeight < 0.0) {
      // Underwater terrain: dark blue (-50) → light blue (0)
      let depthFactor = clamp(-terrainHeight / 50.0, 0.0, 1.0);
      let darkBlue = vec3<f32>(0.0, 0.15, 0.35);
      let lightBlue = vec3<f32>(0.4, 0.7, 0.9);
      debugColor = mix(lightBlue, darkBlue, depthFactor);
    } else {
      // Above water terrain: dark brown (0) → light brown (MAX_TERRAIN_HEIGHT)
      let heightFactor = clamp(terrainHeight / MAX_TERRAIN_HEIGHT, 0.0, 1.0);
      let darkBrown = vec3<f32>(0.35, 0.25, 0.1);
      let lightBrown = vec3<f32>(0.85, 0.75, 0.55);
      debugColor = mix(darkBrown, lightBrown, heightFactor);
    }
    return vec4<f32>(debugColor, 1.0);
  }

  // Compute water surface normal from height gradients
  let texelSize = 1.0 / TEXTURE_SIZE;
  let heightL = textureSample(waterDataTexture, waterSampler, dataUV + vec2<f32>(-texelSize, 0.0)).r;
  let heightR = textureSample(waterDataTexture, waterSampler, dataUV + vec2<f32>(texelSize, 0.0)).r;
  let heightD = textureSample(waterDataTexture, waterSampler, dataUV + vec2<f32>(0.0, -texelSize)).r;
  let heightU = textureSample(waterDataTexture, waterSampler, dataUV + vec2<f32>(0.0, texelSize)).r;

  let heightScale = 3.0;
  let waterNormal = normalize(vec3<f32>(
    (heightL - heightR) * heightScale,
    (heightD - heightU) * heightScale,
    1.0
  ));

  // Compute terrain surface normal from height gradients
  let terrainL = sampleTerrain(dataUV + vec2<f32>(-texelSize, 0.0));
  let terrainR = sampleTerrain(dataUV + vec2<f32>(texelSize, 0.0));
  let terrainD = sampleTerrain(dataUV + vec2<f32>(0.0, -texelSize));
  let terrainU = sampleTerrain(dataUV + vec2<f32>(0.0, texelSize));

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
  let wetnessTexelSize = 1.0 / 2048.0;  // Match WETNESS_TEXTURE_SIZE
  let clampedUV = clamp(wetnessUV, vec2<f32>(0.0), vec2<f32>(1.0));
  let wetness = (
    textureSampleLevel(wetnessTexture, waterSampler, clampedUV, 0.0).r * 0.4 +
    textureSampleLevel(wetnessTexture, waterSampler, clampedUV + vec2<f32>(wetnessTexelSize, 0.0), 0.0).r * 0.15 +
    textureSampleLevel(wetnessTexture, waterSampler, clampedUV + vec2<f32>(-wetnessTexelSize, 0.0), 0.0).r * 0.15 +
    textureSampleLevel(wetnessTexture, waterSampler, clampedUV + vec2<f32>(0.0, wetnessTexelSize), 0.0).r * 0.15 +
    textureSampleLevel(wetnessTexture, waterSampler, clampedUV + vec2<f32>(0.0, -wetnessTexelSize), 0.0).r * 0.15
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
