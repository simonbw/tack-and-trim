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
import { simplexNoise3DModule } from "../../../world/shaders/noise.wgsl";
import { viewportModule } from "../../../world/shaders/coordinates.wgsl";
import {
  gerstnerWaveModule,
  waveModificationStructModule,
} from "../../../world/shaders/gerstner-wave.wgsl";
import { modifierCompositionModule } from "../../../world/shaders/water-modifiers.wgsl";
import {
  NUM_WAVES,
  GERSTNER_STEEPNESS,
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
  params: { type: "uniform", wgslType: "Params" },
  waveData: { type: "storage", wgslType: "array<f32>" },
  modifiers: { type: "storage", wgslType: "array<f32>" },
  outputTexture: { type: "storageTexture", format: "rgba32float" },
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

  protected modules = [
    simplexNoise3DModule,
    viewportModule,
    waveModificationStructModule,
    gerstnerWaveModule,
    modifierCompositionModule,
  ];

  protected mainCode = /*wgsl*/ `
// ============================================================================
// Constants (modules provide: PI, TWO_PI, GRAVITY, MODIFIER_TYPE_*, WaveModification)
// ============================================================================
const NUM_WAVES: i32 = ${NUM_WAVES};
const SWELL_WAVE_COUNT: i32 = ${SWELL_WAVE_COUNT};
const GERSTNER_STEEPNESS: f32 = ${GERSTNER_STEEPNESS};
const WAVE_AMP_MOD_SPATIAL_SCALE: f32 = ${WAVE_AMP_MOD_SPATIAL_SCALE};
const WAVE_AMP_MOD_TIME_SCALE: f32 = ${WAVE_AMP_MOD_TIME_SCALE};
const WAVE_AMP_MOD_STRENGTH: f32 = ${WAVE_AMP_MOD_STRENGTH};
const HEIGHT_SCALE: f32 = ${HEIGHT_SCALE};
const MAX_MODIFIERS: u32 = ${MAX_MODIFIERS}u;
const FLOATS_PER_MODIFIER: u32 = ${FLOATS_PER_MODIFIER}u;
const WATER_VELOCITY_FACTOR: f32 = ${WATER_VELOCITY_FACTOR};
const WATER_HEIGHT_NORM_SCALE: f32 = ${WATER_HEIGHT_SCALE};
const WATER_VELOCITY_NORM_SCALE: f32 = ${WATER_VELOCITY_SCALE};
const SWELL_WAVELENGTH: f32 = ${SWELL_WAVELENGTH}.0;
const CHOP_WAVELENGTH: f32 = ${CHOP_WAVELENGTH}.0;

// ============================================================================
// Structs
// ============================================================================
${AnalyticalWaterParams.wgsl}

// ============================================================================
// Bindings
// ============================================================================
${this.buildWGSLBindings()}

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
// Gerstner Wave Calculation (uses module)
// ============================================================================

fn calculateWaves(worldPos: vec2<f32>, time: f32) -> vec4<f32> {
  // Get wave modification for swell and chop wavelengths
  let swellMod = getWaveModification(worldPos, SWELL_WAVELENGTH);
  let chopMod = getWaveModification(worldPos, CHOP_WAVELENGTH);

  // Sample amplitude modulation noise once per point
  let ampModTime = time * WAVE_AMP_MOD_TIME_SCALE;
  let ampMod = 1.0 + simplex3D(vec3<f32>(
    worldPos.x * WAVE_AMP_MOD_SPATIAL_SCALE,
    worldPos.y * WAVE_AMP_MOD_SPATIAL_SCALE,
    ampModTime
  )) * WAVE_AMP_MOD_STRENGTH;

  // Use Gerstner wave module
  return calculateGerstnerWaves(
    worldPos,
    time,
    &waveData,
    NUM_WAVES,
    SWELL_WAVE_COUNT,
    GERSTNER_STEEPNESS,
    swellMod,
    chopMod,
    ampMod,
    params.waveSourceDirection
  );
}

// ============================================================================
// Water Modifier Calculation (uses module)
// ============================================================================

// Wrapper function to call module with correct signature
fn calculateModifiersWrapper(worldX: f32, worldY: f32) -> vec3<f32> {
  return calculateModifiers(
    worldX,
    worldY,
    params.modifierCount,
    MAX_MODIFIERS,
    &modifiers,
    FLOATS_PER_MODIFIER
  );
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

  // Wave contribution with texture-based shadow sampling
  let waveResult = calculateWaves(worldPos, params.time);
  let waveHeight = waveResult.x;
  let waveDhdt = waveResult.w;

  // Modifier contribution (wake effects)
  let modifierResult = calculateModifiersWrapper(worldPos.x, worldPos.y);
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
