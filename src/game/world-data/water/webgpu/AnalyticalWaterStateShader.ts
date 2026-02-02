/**
 * Analytical Water State Compute Shader
 *
 * Uses a texture-based shadow system for wave diffraction:
 * - Shadow texture (r8uint): sampled to determine if pixel is in shadow
 * - Shadow data uniform: contains silhouette positions for distance calculations
 *
 * Key differences from the old approach:
 * - Uses shadow texture sampling instead of per-pixel polygon iteration
 * - Simple texture lookup replaces expensive winding number algorithm
 * - Distance calculations use silhouette points from uniform buffer
 *
 * Output format (rgba32float):
 * - R: Combined height (waves + modifiers), normalized
 * - G: dh/dt (rate of height change), normalized
 * - B: Water velocity X (from modifiers), normalized
 * - A: Water velocity Y (from modifiers), normalized
 */

import { ComputeShader } from "../../../../core/graphics/webgpu/ComputeShader";
import { SIMPLEX_NOISE_3D_WGSL } from "../../../../core/graphics/webgpu/WGSLSnippets";
import {
  NUM_WAVES,
  GERSTNER_STEEPNESS,
  GRAVITY_FT_PER_S2,
  WAVE_AMP_MOD_SPATIAL_SCALE,
  WAVE_AMP_MOD_TIME_SCALE,
  WAVE_AMP_MOD_STRENGTH,
  WATER_HEIGHT_SCALE,
  WATER_VELOCITY_SCALE,
  SWELL_WAVE_COUNT,
} from "../WaterConstants";
import { MAX_MODIFIERS, FLOATS_PER_MODIFIER } from "./WaterComputeBuffers";
import { AnalyticalWaterParams } from "./AnalyticalWaterParams";

// Constants for modifier computation
const HEIGHT_SCALE = 0.5;
const WATER_VELOCITY_FACTOR = 0.0;

// Default wavelength for diffraction calculation (feet)
const SWELL_WAVELENGTH = 200;
const CHOP_WAVELENGTH = 30;

// Maximum number of shadow polygons in the uniform buffer
export const MAX_SHADOW_POLYGONS = 8;

const bindings = {
  params: { type: "uniform" },
  waveData: { type: "storage" },
  modifiers: { type: "storage" },
  outputTexture: { type: "storageTexture", format: "rgba32float" },
  depthTexture: { type: "texture", viewDimension: "2d", sampleType: "float" },
  depthSampler: { type: "sampler" },
  shadowTexture: {
    type: "texture",
    viewDimension: "2d",
    sampleType: "float",
  },
  shadowSampler: { type: "sampler" },
} as const;

/**
 * Analytical water state compute shader using shadow texture sampling.
 */
export class AnalyticalWaterStateShader extends ComputeShader<typeof bindings> {
  readonly bindings = bindings;
  readonly workgroupSize = [8, 8] as const;

  readonly code = /*wgsl*/ `
// ============================================================================
// Constants
// ============================================================================
const PI: f32 = 3.14159265359;
const TWO_PI: f32 = 6.28318530718;
const NUM_WAVES: i32 = ${NUM_WAVES};
const SWELL_WAVE_COUNT: i32 = ${SWELL_WAVE_COUNT};
const GERSTNER_STEEPNESS: f32 = ${GERSTNER_STEEPNESS};
const GRAVITY: f32 = ${GRAVITY_FT_PER_S2};
const WAVE_AMP_MOD_SPATIAL_SCALE: f32 = ${WAVE_AMP_MOD_SPATIAL_SCALE};
const WAVE_AMP_MOD_TIME_SCALE: f32 = ${WAVE_AMP_MOD_TIME_SCALE};
const WAVE_AMP_MOD_STRENGTH: f32 = ${WAVE_AMP_MOD_STRENGTH};
const HEIGHT_SCALE: f32 = ${HEIGHT_SCALE};
const MAX_MODIFIERS: u32 = ${MAX_MODIFIERS}u;
const FLOATS_PER_MODIFIER: u32 = ${FLOATS_PER_MODIFIER}u;
const WATER_VELOCITY_FACTOR: f32 = ${WATER_VELOCITY_FACTOR};

// Modifier type discriminators
const MODIFIER_TYPE_WAKE: u32 = 1u;
const MODIFIER_TYPE_RIPPLE: u32 = 2u;
const MODIFIER_TYPE_CURRENT: u32 = 3u;
const MODIFIER_TYPE_OBSTACLE: u32 = 4u;
const WATER_HEIGHT_NORM_SCALE: f32 = ${WATER_HEIGHT_SCALE};
const WATER_VELOCITY_NORM_SCALE: f32 = ${WATER_VELOCITY_SCALE};
const SWELL_WAVELENGTH: f32 = ${SWELL_WAVELENGTH}.0;
const CHOP_WAVELENGTH: f32 = ${CHOP_WAVELENGTH}.0;
const MAX_SHADOW_POLYGONS: u32 = ${MAX_SHADOW_POLYGONS}u;
const ERF_APPROX_COEFF: f32 = 0.7;

// ============================================================================
// Structs
// ============================================================================
${AnalyticalWaterParams.wgsl}

// Wave modification result
struct WaveModification {
  energyFactor: f32,
  newDirection: vec2<f32>,
}

// ============================================================================
// Bindings
// ============================================================================
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> waveData: array<f32>;
@group(0) @binding(2) var<storage, read> modifiers: array<f32>;
@group(0) @binding(3) var outputTexture: texture_storage_2d<rgba32float, write>;
@group(0) @binding(4) var depthTexture: texture_2d<f32>;
@group(0) @binding(5) var depthSampler: sampler;
@group(0) @binding(6) var shadowTexture: texture_2d<f32>;
@group(0) @binding(7) var shadowSampler: sampler;

// Simplex 3D Noise - for wave amplitude modulation
${SIMPLEX_NOISE_3D_WGSL}

// ============================================================================
// Depth Sampling
// ============================================================================

fn sampleDepth(worldPos: vec2<f32>) -> f32 {
  let u = (worldPos.x - params.depthOriginX) / params.depthGridWidth;
  let v = (worldPos.y - params.depthOriginY) / params.depthGridHeight;

  // Bounds check - outside depth grid is treated as deep water
  if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) {
    return -100.0;  // Deep water
  }

  return textureSampleLevel(depthTexture, depthSampler, vec2<f32>(u, v), 0.0).r;
}

// ============================================================================
// Shadow Texture Sampling
// ============================================================================

// Sample shadow attenuation texture
// Returns vec2<f32> with R=swell attenuation, G=chop attenuation
// Values range from 0.0 (full shadow) to 1.0 (full energy)
fn sampleShadowTexture(worldPos: vec2<f32>) -> vec2<f32> {
  // Convert world position to shadow texture UV (viewport matches params viewport)
  let u = (worldPos.x - params.viewportLeft) / params.viewportWidth;
  let v = (worldPos.y - params.viewportTop) / params.viewportHeight;

  // Sample shadow attenuation texture (rg16float format)
  // Use linear filtering for smooth transitions
  let attenuation = textureSampleLevel(shadowTexture, shadowSampler, vec2<f32>(u, v), 0.0);

  return attenuation.rg;
}

// Fresnel diffraction is now pre-computed in the shadow texture
// No runtime computation needed!

// Green's Law shoaling factor
fn computeShoalingFactor(waterDepth: f32, wavelength: f32) -> f32 {
  let DEEP_WATER_DEPTH: f32 = 100.0;
  let MIN_DEPTH: f32 = 2.0;
  let shallowThreshold = wavelength * 0.5;

  if (waterDepth > shallowThreshold) {
    return 1.0;
  }

  let shallowFactor = 1.0 - smoothstep(shallowThreshold * 0.5, shallowThreshold, waterDepth);
  let effectiveDepth = max(waterDepth, MIN_DEPTH);
  let greenFactor = pow(DEEP_WATER_DEPTH / effectiveDepth, 0.25);
  let maxShoaling = 2.0;

  return 1.0 + (min(greenFactor, maxShoaling) - 1.0) * shallowFactor;
}

// Bottom friction damping factor
fn computeShallowDamping(waterDepth: f32) -> f32 {
  let DEEP_THRESHOLD: f32 = 10.0;
  let SHALLOW_THRESHOLD: f32 = 2.0;
  let MIN_DAMPING: f32 = 0.2;

  if (waterDepth >= DEEP_THRESHOLD) {
    return 1.0;
  }
  if (waterDepth <= SHALLOW_THRESHOLD) {
    return MIN_DAMPING;
  }

  return mix(MIN_DAMPING, 1.0, (waterDepth - SHALLOW_THRESHOLD) / (DEEP_THRESHOLD - SHALLOW_THRESHOLD));
}

// ============================================================================
// Wave Modification (Pre-computed Shadow Sampling)
// ============================================================================

fn getWaveModification(worldPos: vec2<f32>, wavelength: f32) -> WaveModification {
  var result: WaveModification;
  result.newDirection = vec2<f32>(cos(params.waveSourceDirection), sin(params.waveSourceDirection));

  // Sample pre-computed shadow attenuation
  let attenuation = sampleShadowTexture(worldPos);

  // Pick the right wavelength channel
  // R channel = swell (long wavelength)
  // G channel = chop (short wavelength)
  if (wavelength > 100.0) {
    result.energyFactor = attenuation.r;
  } else {
    result.energyFactor = attenuation.g;
  }

  return result;
}

// ============================================================================
// Gerstner Wave Calculation
// ============================================================================

fn calculateWaves(worldPos: vec2<f32>, time: f32) -> vec4<f32> {
  let x = worldPos.x;
  let y = worldPos.y;

  // Get wave modification for swell and chop wavelengths
  let swellMod = getWaveModification(worldPos, SWELL_WAVELENGTH);
  let chopMod = getWaveModification(worldPos, CHOP_WAVELENGTH);

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
    var direction = waveData[base + 2];
    let phaseOffset = waveData[base + 3];
    let speedMult = waveData[base + 4];
    let sourceDist = waveData[base + 5];
    let sourceOffsetX = waveData[base + 6];
    let sourceOffsetY = waveData[base + 7];

    // Apply direction modification from diffraction
    var waveMod: WaveModification;
    if (i < SWELL_WAVE_COUNT) {
      waveMod = swellMod;
    } else {
      waveMod = chopMod;
    }

    let modDir = waveMod.newDirection;
    let dirOffset = atan2(modDir.y, modDir.x) - params.waveSourceDirection;
    direction += dirOffset;

    let baseDx = cos(direction);
    let baseDy = sin(direction);
    let k = (2.0 * PI) / wavelength;
    let omega = sqrt(GRAVITY * k) * speedMult;

    var dx: f32;
    var dy: f32;
    var phase: f32;

    if (sourceDist > 1e9) {
      dx = baseDx;
      dy = baseDy;
      let projected = x * dx + y * dy;
      phase = k * projected - omega * time + phaseOffset;
    } else {
      let sourceX = -baseDx * sourceDist + sourceOffsetX;
      let sourceY = -baseDy * sourceDist + sourceOffsetY;

      let toPointX = x - sourceX;
      let toPointY = y - sourceY;
      let distFromSource = sqrt(toPointX * toPointX + toPointY * toPointY);

      dx = toPointX / distFromSource;
      dy = toPointY / distFromSource;
      phase = k * distFromSource - omega * time + phaseOffset;
    }

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
    var amplitude = waveData[base + 0];
    let wavelength = waveData[base + 1];
    var direction = waveData[base + 2];
    let phaseOffset = waveData[base + 3];
    let speedMult = waveData[base + 4];
    let sourceDist = waveData[base + 5];
    let sourceOffsetX = waveData[base + 6];
    let sourceOffsetY = waveData[base + 7];

    // Apply wave modification (energy and direction)
    var waveMod: WaveModification;
    if (i < SWELL_WAVE_COUNT) {
      waveMod = swellMod;
      amplitude *= waveMod.energyFactor;
    } else {
      waveMod = chopMod;
      amplitude *= waveMod.energyFactor;
    }

    let modDir = waveMod.newDirection;
    let dirOffset = atan2(modDir.y, modDir.x) - params.waveSourceDirection;
    direction += dirOffset;

    let baseDx = cos(direction);
    let baseDy = sin(direction);
    let k = (2.0 * PI) / wavelength;
    let omega = sqrt(GRAVITY * k) * speedMult;

    var phase: f32;

    if (sourceDist > 1e9) {
      let projected = sampleX * baseDx + sampleY * baseDy;
      phase = k * projected - omega * time + phaseOffset;
    } else {
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
    dhdt += -amplitude * ampMod * omega * cosPhase;
  }

  return vec4<f32>(height, dispX, dispY, dhdt);
}

// ============================================================================
// Water Modifier Calculation
// ============================================================================

// Wake modifier - circular falloff from point
fn computeWakeContribution(worldX: f32, worldY: f32, base: u32) -> vec3<f32> {
  let intensity = modifiers[base + 5u];
  let velocityX = modifiers[base + 6u];
  let velocityY = modifiers[base + 7u];

  // Compute distance to wake center (from bounds center)
  let minX = modifiers[base + 1u];
  let minY = modifiers[base + 2u];
  let maxX = modifiers[base + 3u];
  let maxY = modifiers[base + 4u];
  let centerX = (minX + maxX) * 0.5;
  let centerY = (minY + maxY) * 0.5;
  let dx = worldX - centerX;
  let dy = worldY - centerY;
  let dist = sqrt(dx * dx + dy * dy);

  // Circular falloff
  let radius = (maxX - minX) * 0.5;
  let falloff = max(0.0, 1.0 - dist / radius);

  // Return (height, velocityX, velocityY)
  return vec3<f32>(
    intensity * falloff * cos(dist * 0.1),
    velocityX * falloff,
    velocityY * falloff
  );
}

// Ripple modifier - ring-based contribution
fn computeRippleContribution(worldX: f32, worldY: f32, base: u32) -> vec3<f32> {
  let radius = modifiers[base + 5u];
  let intensity = modifiers[base + 6u];
  let phase = modifiers[base + 7u];

  let minX = modifiers[base + 1u];
  let minY = modifiers[base + 2u];
  let maxX = modifiers[base + 3u];
  let maxY = modifiers[base + 4u];
  let centerX = (minX + maxX) * 0.5;
  let centerY = (minY + maxY) * 0.5;
  let dx = worldX - centerX;
  let dy = worldY - centerY;
  let dist = sqrt(dx * dx + dy * dy);

  // Ring-based falloff (2ft wide ring)
  let ringWidth = 2.0;
  let distFromRing = abs(dist - radius);
  let falloff = max(0.0, 1.0 - distFromRing / ringWidth);

  // Cosine wave profile
  let height = intensity * falloff * cos(phase);

  return vec3<f32>(height, 0.0, 0.0);
}

// Current modifier - directional flow field (future use)
fn computeCurrentContribution(worldX: f32, worldY: f32, base: u32) -> vec3<f32> {
  let velocityX = modifiers[base + 5u];
  let velocityY = modifiers[base + 6u];
  let fadeDistance = modifiers[base + 7u];

  // Simple constant velocity for now
  return vec3<f32>(0.0, velocityX, velocityY);
}

// Obstacle modifier - dampening zone (future use)
fn computeObstacleContribution(worldX: f32, worldY: f32, base: u32) -> vec3<f32> {
  let dampingFactor = modifiers[base + 5u];

  // Not implemented yet - return zero contribution
  return vec3<f32>(0.0, 0.0, 0.0);
}

// Main modifier contribution function with type discrimination
fn getModifierContribution(worldX: f32, worldY: f32, modifierIndex: u32) -> vec3<f32> {
  let base = modifierIndex * FLOATS_PER_MODIFIER;

  // Read header
  let modType = u32(modifiers[base + 0u]);
  let minX = modifiers[base + 1u];
  let minY = modifiers[base + 2u];
  let maxX = modifiers[base + 3u];
  let maxY = modifiers[base + 4u];

  // Bounds culling (early exit)
  if (worldX < minX || worldX > maxX || worldY < minY || worldY > maxY) {
    return vec3<f32>(0.0, 0.0, 0.0);
  }

  // Type discrimination
  switch (modType) {
    case MODIFIER_TYPE_WAKE: {
      return computeWakeContribution(worldX, worldY, base);
    }
    case MODIFIER_TYPE_RIPPLE: {
      return computeRippleContribution(worldX, worldY, base);
    }
    case MODIFIER_TYPE_CURRENT: {
      return computeCurrentContribution(worldX, worldY, base);
    }
    case MODIFIER_TYPE_OBSTACLE: {
      return computeObstacleContribution(worldX, worldY, base);
    }
    default: {
      return vec3<f32>(0.0, 0.0, 0.0);
    }
  }
}

fn calculateModifiers(worldX: f32, worldY: f32) -> vec3<f32> {
  var totalHeight: f32 = 0.0;
  var totalVelX: f32 = 0.0;
  var totalVelY: f32 = 0.0;

  let modifierCount = min(params.modifierCount, MAX_MODIFIERS);
  for (var i: u32 = 0u; i < modifierCount; i++) {
    let contrib = getModifierContribution(worldX, worldY, i);
    totalHeight += contrib.x;
    totalVelX += contrib.y;
    totalVelY += contrib.z;
  }

  return vec3<f32>(totalHeight, totalVelX, totalVelY);
}

// ============================================================================
// Main
// ============================================================================

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let texSize = vec2<f32>(params.textureSizeX, params.textureSizeY);

  if (f32(globalId.x) >= texSize.x || f32(globalId.y) >= texSize.y) {
    return;
  }

  // Convert texel to world position
  let uv = vec2<f32>(f32(globalId.x) + 0.5, f32(globalId.y) + 0.5) / texSize;
  let worldPos = vec2<f32>(
    params.viewportLeft + uv.x * params.viewportWidth,
    params.viewportTop + uv.y * params.viewportHeight
  );

  // Sample depth for shoaling/damping
  let depth = sampleDepth(worldPos);

  // On land (positive depth), output zero water state
  if (depth >= 0.0) {
    textureStore(outputTexture, vec2<i32>(globalId.xy), vec4<f32>(0.5, 0.5, 0.5, 0.5));
    return;
  }

  // Compute shoaling and damping factors
  let waterDepth = -depth;
  let shoalingFactor = computeShoalingFactor(waterDepth, SWELL_WAVELENGTH);
  let dampingFactor = computeShallowDamping(waterDepth);
  let depthModifier = shoalingFactor * dampingFactor;

  // Wave contribution with texture-based shadow sampling
  let waveResult = calculateWaves(worldPos, params.time);
  var waveHeight = waveResult.x;
  var waveDhdt = waveResult.w;

  // Apply shoaling/damping
  waveHeight *= depthModifier;
  waveDhdt *= depthModifier;

  // Modifier contribution (wake effects)
  let modifierResult = calculateModifiers(worldPos.x, worldPos.y);
  let modifierHeight = modifierResult.x;
  let modifierVelX = modifierResult.y;
  let modifierVelY = modifierResult.z;

  // Combined output
  let totalHeight = waveHeight + modifierHeight + params.tideHeight;
  let normalizedHeight = totalHeight / WATER_HEIGHT_NORM_SCALE + 0.5;
  let normalizedDhdt = waveDhdt / WATER_VELOCITY_NORM_SCALE + 0.5;
  let normalizedVelX = modifierVelX / WATER_VELOCITY_NORM_SCALE + 0.5;
  let normalizedVelY = modifierVelY / WATER_VELOCITY_NORM_SCALE + 0.5;

  textureStore(outputTexture, vec2<i32>(globalId.xy), vec4<f32>(normalizedHeight, normalizedDhdt, normalizedVelX, normalizedVelY));
}
`;
}
