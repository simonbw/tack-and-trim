/**
 * Unified Surface Fullscreen Shader
 *
 * Computes water + terrain heights per-pixel in a single fullscreen pass.
 * Eliminates the need for separate water/terrain compute passes and intermediate textures.
 *
 * Uses existing shader modules:
 * - gerstnerWaveModule for wave computation
 * - terrainHeightComputeModule for terrain height
 * - waterLightingModule for water surface lighting
 * - sandRenderingModule for sand/beach rendering
 * - fn_calculateModifiers for water modifiers (wakes, etc.)
 *
 * Binds directly to:
 * - WaterResources (waveDataBuffer, modifiersBuffer)
 * - TerrainResources (vertexBuffer, contourBuffer, childrenBuffer)
 * - WavePhysicsResources (shadowTexture for diffraction)
 */

import {
  FullscreenShader,
  type FullscreenShaderConfig,
} from "../../core/graphics/webgpu/FullscreenShader";
import type { ShaderModule } from "../../core/graphics/webgpu/ShaderModule";
import {
  GERSTNER_STEEPNESS,
  MAX_WAVES,
  WATER_HEIGHT_SCALE,
  WAVE_AMP_MOD_SPATIAL_SCALE,
  WAVE_AMP_MOD_STRENGTH,
  WAVE_AMP_MOD_TIME_SCALE,
} from "../world/water/WaterConstants";
import {
  FLOATS_PER_MODIFIER,
  MAX_MODIFIERS,
} from "../world/water/WaterResources";
import { DEFAULT_DEPTH } from "../world/terrain/TerrainConstants";
import { fn_renderWaterLighting } from "../world/shaders/lighting.wgsl";
import { fn_hash21 } from "../world/shaders/math.wgsl";
import { fn_renderSand } from "../world/shaders/sand-rendering.wgsl";
import { fn_simplex3D } from "../world/shaders/noise.wgsl";
import {
  fn_calculateGerstnerWaves,
  struct_WaveModification,
} from "../world/shaders/gerstner-wave.wgsl";
import { fn_calculateModifiers } from "../world/shaders/water-modifiers.wgsl";
import {
  struct_ContourData,
  fn_computeSignedDistance,
} from "../world/shaders/terrain.wgsl";
import { UnifiedSurfaceUniforms } from "./UnifiedSurfaceUniforms";

// Default wavelengths for diffraction calculation
const SWELL_WAVELENGTH = 200;
const CHOP_WAVELENGTH = 30;

/**
 * Module containing Uniforms struct and resource bindings.
 */
const unifiedSurfaceBindingsModule: ShaderModule = {
  preamble: UnifiedSurfaceUniforms.wgsl,
  bindings: {
    // Uniforms
    uniforms: { type: "uniform", wgslType: "Uniforms" },

    // Water resources (from WaterResources)
    waveData: { type: "storage", wgslType: "array<f32>" },
    modifiers: { type: "storage", wgslType: "array<f32>" },

    // Terrain resources (from TerrainResources)
    vertices: { type: "storage", wgslType: "array<vec2<f32>>" },
    contours: { type: "storage", wgslType: "array<ContourData>" },
    children: { type: "storage", wgslType: "array<u32>" },

    // Shadow texture (from WavePhysicsResources)
    shadowTexture: {
      type: "texture",
      viewDimension: "2d",
      sampleType: "float",
    },
    shadowSampler: { type: "sampler" },
  },
  code: "",
};

/**
 * Module containing the vertex and fragment entry points.
 */
const unifiedSurfaceMainModule: ShaderModule = {
  dependencies: [
    fn_hash21,
    fn_simplex3D,
    struct_WaveModification,
    fn_calculateGerstnerWaves,
    fn_calculateModifiers,
    struct_ContourData,
    fn_computeSignedDistance,
    fn_renderWaterLighting,
    fn_renderSand,
    unifiedSurfaceBindingsModule,
  ],
  code: /*wgsl*/ `
// ============================================================================
// Constants
// NOTE: This shader is legacy and not currently used. Wave counts are hardcoded.
// ============================================================================
const MAX_WAVES: i32 = ${MAX_WAVES};
const NUM_WAVES: i32 = 2; // Legacy: hardcoded for unused shader
const SWELL_WAVE_COUNT: i32 = 1; // Legacy: hardcoded for unused shader
const GERSTNER_STEEPNESS: f32 = ${GERSTNER_STEEPNESS};
const WAVE_AMP_MOD_SPATIAL_SCALE: f32 = ${WAVE_AMP_MOD_SPATIAL_SCALE};
const WAVE_AMP_MOD_TIME_SCALE: f32 = ${WAVE_AMP_MOD_TIME_SCALE};
const WAVE_AMP_MOD_STRENGTH: f32 = ${WAVE_AMP_MOD_STRENGTH};
const MAX_MODIFIERS: u32 = ${MAX_MODIFIERS}u;
const FLOATS_PER_MODIFIER: u32 = ${FLOATS_PER_MODIFIER}u;
const WATER_HEIGHT_SCALE: f32 = ${WATER_HEIGHT_SCALE};
const SWELL_WAVELENGTH: f32 = ${SWELL_WAVELENGTH}.0;
const CHOP_WAVELENGTH: f32 = ${CHOP_WAVELENGTH}.0;
const DEFAULT_DEPTH: f32 = ${DEFAULT_DEPTH}.0;

// ============================================================================
// Vertex Shader
// ============================================================================

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

// ============================================================================
// Shadow Texture Sampling (for wave diffraction)
// ============================================================================

fn sampleShadowTexture(worldPos: vec2<f32>) -> vec2<f32> {
  let u = (worldPos.x - uniforms.viewportLeft) / uniforms.viewportWidth;
  let v = (worldPos.y - uniforms.viewportTop) / uniforms.viewportHeight;
  let attenuation = textureSampleLevel(shadowTexture, shadowSampler, vec2<f32>(u, v), 0.0);
  return attenuation.rg;
}

fn getWaveModification(worldPos: vec2<f32>, wavelength: f32) -> WaveModification {
  var result: WaveModification;
  result.newDirection = vec2<f32>(cos(uniforms.waveSourceDirection), sin(uniforms.waveSourceDirection));

  let attenuation = sampleShadowTexture(worldPos);

  // R channel = swell (long wavelength), G channel = chop (short wavelength)
  if (wavelength > 100.0) {
    result.energyFactor = attenuation.r;
  } else {
    result.energyFactor = attenuation.g;
  }

  return result;
}

// ============================================================================
// Water Height Calculation
// ============================================================================

fn calculateWaterHeight(worldPos: vec2<f32>) -> vec4<f32> {
  // Get wave modification for swell and chop wavelengths
  let swellMod = getWaveModification(worldPos, SWELL_WAVELENGTH);
  let chopMod = getWaveModification(worldPos, CHOP_WAVELENGTH);

  // Sample amplitude modulation noise
  let ampModTime = uniforms.time * WAVE_AMP_MOD_TIME_SCALE;
  let ampMod = 1.0 + simplex3D(vec3<f32>(
    worldPos.x * WAVE_AMP_MOD_SPATIAL_SCALE,
    worldPos.y * WAVE_AMP_MOD_SPATIAL_SCALE,
    ampModTime
  )) * WAVE_AMP_MOD_STRENGTH;

  // Calculate Gerstner waves
  let waveResult = calculateGerstnerWaves(
    worldPos,
    uniforms.time,
    &waveData,
    NUM_WAVES,
    SWELL_WAVE_COUNT,
    GERSTNER_STEEPNESS,
    swellMod,
    chopMod,
    ampMod,
    uniforms.waveSourceDirection
  );

  // Calculate modifier contributions (wakes, etc.)
  let modifierResult = calculateModifiers(
    worldPos.x,
    worldPos.y,
    uniforms.modifierCount,
    MAX_MODIFIERS,
    &modifiers,
    FLOATS_PER_MODIFIER
  );

  // Combined height = waves + modifiers + tide
  let totalHeight = waveResult.x + modifierResult.x + uniforms.tideHeight;

  // Return (height, dispX, dispY, dhdt)
  return vec4<f32>(totalHeight, waveResult.y, waveResult.z, waveResult.w);
}

// ============================================================================
// Terrain Height Calculation (wrapper for fn_computeSignedDistance)
// ============================================================================

fn getTerrainHeight(worldPos: vec2<f32>) -> f32 {
  if (uniforms.hasTerrainData == 0) {
    return uniforms.defaultDepth;
  }

  var deepestHeight = uniforms.defaultDepth;
  var deepestDepth: u32 = 0u;

  // Find the deepest contour containing the point
  // Vertices are pre-sampled from Catmull-Rom splines on the CPU
  for (var i: u32 = 0u; i < uniforms.contourCount; i++) {
    let signedDist = computeSignedDistance(
      worldPos,
      i,
      &vertices,
      &contours
    );

    // Inside this contour (negative signed distance)
    if (signedDist < 0.0) {
      let contour = contours[i];
      // Update if this is deeper than current deepest
      if (contour.depth >= deepestDepth) {
        deepestDepth = contour.depth;
        deepestHeight = contour.height;
      }
    }
  }

  return deepestHeight;
}

// ============================================================================
// Water Normal Calculation (via finite differences)
// ============================================================================

fn computeWaterNormalAtPoint(worldPos: vec2<f32>) -> vec3<f32> {
  let offset = 1.0;

  let h0 = calculateWaterHeight(worldPos).x;
  let hx = calculateWaterHeight(worldPos + vec2<f32>(offset, 0.0)).x;
  let hy = calculateWaterHeight(worldPos + vec2<f32>(0.0, offset)).x;

  let dx = (hx - h0) / offset;
  let dy = (hy - h0) / offset;

  return normalize(vec3<f32>(-dx * 0.5, -dy * 0.5, 1.0));
}

// ============================================================================
// Terrain Normal Calculation (via finite differences)
// ============================================================================

fn computeTerrainNormalAtPoint(worldPos: vec2<f32>) -> vec3<f32> {
  let offset = 2.0;

  let h0 = getTerrainHeight(worldPos);
  let hx = getTerrainHeight(worldPos + vec2<f32>(offset, 0.0));
  let hy = getTerrainHeight(worldPos + vec2<f32>(0.0, offset));

  let dx = (hx - h0) / offset;
  let dy = (hy - h0) / offset;

  return normalize(vec3<f32>(-dx * 0.5, -dy * 0.5, 1.0));
}

// ============================================================================
// Water Rendering (calls waterLightingModule)
// ============================================================================

fn renderWater(rawHeight: f32, normal: vec3<f32>, worldPos: vec2<f32>, waterDepth: f32) -> vec3<f32> {
  let viewDir = vec3<f32>(0.0, 0.0, 1.0);

  // Normalize height to 0-1 range for lighting
  let normalizedHeight = rawHeight / WATER_HEIGHT_SCALE + 0.5;

  var color = renderWaterLighting(normal, viewDir, normalizedHeight, waterDepth);

  // Add high-frequency noise
  let fineNoise = hash21(worldPos * 2.0) * 0.02 - 0.01;
  color = color + fineNoise;

  return color;
}

// ============================================================================
// Fragment Shader
// ============================================================================

@fragment
fn fs_main(@location(0) clipPosition: vec2<f32>) -> @location(0) vec4<f32> {
  // Convert clip space (-1,1) to screen coords (0, screenSize)
  let screenPos = (clipPosition * 0.5 + 0.5) * vec2<f32>(uniforms.screenWidth, uniforms.screenHeight);

  // Transform screen position to world position using camera matrix
  let worldPosH = uniforms.cameraMatrix * vec3<f32>(screenPos, 1.0);
  let worldPos = worldPosH.xy;

  // Compute water height directly (no texture sampling)
  let waterResult = calculateWaterHeight(worldPos);
  let waterSurfaceHeight = waterResult.x;

  // Compute terrain height directly (no texture sampling)
  let terrainHeight = getTerrainHeight(worldPos);

  // Calculate water depth (water surface height - terrain height)
  let waterDepth = waterSurfaceHeight - terrainHeight;

  // Compute normals via finite differences
  let waterNormal = computeWaterNormalAtPoint(worldPos);
  let terrainNormal = computeTerrainNormalAtPoint(worldPos);

  // Blend normals: terrain on land, water in deep water, blend in shallow
  var normal: vec3<f32>;
  if (waterDepth < 0.0) {
    normal = terrainNormal;
  } else if (waterDepth < uniforms.shallowThreshold) {
    let blendFactor = waterDepth / uniforms.shallowThreshold;
    normal = normalize(mix(terrainNormal, waterNormal, blendFactor));
  } else {
    normal = waterNormal;
  }

  // Render based on water depth
  if (waterDepth < 0.0) {
    // Above water - render sand (no wetness for now in Phase 1)
    let sandColor = renderSand(terrainHeight, normal, worldPos, 0.0);
    return vec4<f32>(sandColor, 1.0);
  } else if (waterDepth < uniforms.shallowThreshold) {
    // Shallow water - blend sand and water with minimum water visibility
    let rawBlend = smoothstep(0.0, uniforms.shallowThreshold, waterDepth);
    let minWaterBlend = 0.35;
    let blendFactor = mix(minWaterBlend, 1.0, rawBlend);

    let sandColor = renderSand(terrainHeight, normal, worldPos, 0.0);
    let waterColor = renderWater(waterSurfaceHeight, normal, worldPos, waterDepth);
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
    let color = renderWater(waterSurfaceHeight, normal, worldPos, waterDepth);
    return vec4<f32>(color, 1.0);
  }
}
  `,
};

/**
 * Configuration for the unified surface shader.
 */
export const unifiedSurfaceShaderConfig: FullscreenShaderConfig = {
  modules: [unifiedSurfaceMainModule],
  label: "UnifiedSurfaceShader",
};

/**
 * Create a unified surface fullscreen shader instance.
 */
export function createUnifiedSurfaceShader(): FullscreenShader {
  return new FullscreenShader(unifiedSurfaceShaderConfig);
}
