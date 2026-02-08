/**
 * Water Query Compute Shader
 *
 * Samples water data (height, velocity, normals, depth) at arbitrary query points.
 * Uses the same modular shader code as the water state shader.
 * Includes modifier support for wakes, ripples, currents, and obstacles.
 * Supports per-wave analytical shadow attenuation for wave energy reduction behind obstacles.
 *
 * Input:  pointBuffer (storage) - array of vec2<f32> query points
 * Output: resultBuffer (storage) - array of WaterQueryResult structs
 */

import {
  defineUniformStruct,
  f32,
  u32,
} from "../../../core/graphics/UniformStruct";
import {
  ComputeShader,
  type ComputeShaderConfig,
} from "../../../core/graphics/webgpu/ComputeShader";
import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";
import { fn_calculateGerstnerWaves } from "../shaders/gerstner-wave.wgsl";
import { fn_simplex3D } from "../shaders/noise.wgsl";
import { fn_computeShadowForWave } from "../shaders/shadow-attenuation.wgsl";
import {
  fn_computeTerrainHeight,
  struct_ContourData,
} from "../shaders/terrain.wgsl";
import { fn_calculateModifiers } from "../shaders/water-modifiers.wgsl";
import { fn_computeWaveTerrainFactor } from "../shaders/wave-terrain.wgsl";
import { fn_computeRefractionOffset } from "../shaders/wave-physics.wgsl";
import {
  GERSTNER_STEEPNESS,
  MAX_WAVES,
  WAVE_AMP_MOD_SPATIAL_SCALE,
  WAVE_AMP_MOD_STRENGTH,
  WAVE_AMP_MOD_TIME_SCALE,
} from "./WaterConstants";
import { FLOATS_PER_MODIFIER, MAX_MODIFIERS } from "./WaterResources";

const WORKGROUP_SIZE = [64, 1, 1] as const;

/**
 * Uniform struct for water query parameters.
 */
export const WaterQueryUniforms = defineUniformStruct("Params", {
  pointCount: u32,
  time: f32,
  tideHeight: f32,
  modifierCount: u32,
  contourCount: u32,
  defaultDepth: f32,
  numWaves: u32,
  _padding0: f32,
  _padding1: f32,
  _padding2: f32,
  _padding3: f32,
  _padding4: f32,
});

/**
 * Module containing Params and result structs, plus bindings.
 */
const waterQueryParamsModule: ShaderModule = {
  dependencies: [struct_ContourData],
  preamble: /*wgsl*/ `
// Query parameters (48 bytes)
struct Params {
  pointCount: u32,
  time: f32,
  tideHeight: f32,
  modifierCount: u32,
  contourCount: u32,
  defaultDepth: f32,
  numWaves: u32,
  _padding0: f32,
  _padding1: f32,
  _padding2: f32,
  _padding3: f32,
  _padding4: f32,
}

// Result structure (matches WaterQueryResult interface)
struct WaterQueryResult {
  surfaceHeight: f32,
  velocityX: f32,
  velocityY: f32,
  normalX: f32,
  normalY: f32,
  depth: f32,
}
  `,
  bindings: {
    params: { type: "uniform", wgslType: "Params" },
    waveData: { type: "storage", wgslType: "array<f32>" },
    modifiers: { type: "storage", wgslType: "array<f32>" },
    packedShadow: { type: "storage", wgslType: "array<u32>" },
    packedTerrain: { type: "storage", wgslType: "array<u32>" },
    pointBuffer: { type: "storage", wgslType: "array<vec2<f32>>" },
    resultBuffer: { type: "storageRW", wgslType: "array<WaterQueryResult>" },
  },
  code: "",
};

/**
 * Module containing the compute entry point.
 */
const waterQueryMainModule: ShaderModule = {
  dependencies: [
    waterQueryParamsModule,
    fn_simplex3D,
    fn_calculateGerstnerWaves,
    fn_calculateModifiers,
    fn_computeShadowForWave,
    fn_computeTerrainHeight,
    fn_computeWaveTerrainFactor,
    fn_computeRefractionOffset,
  ],
  code: /*wgsl*/ `
// Constants
const MAX_WAVES: i32 = ${MAX_WAVES};
const GERSTNER_STEEPNESS: f32 = ${GERSTNER_STEEPNESS};
const WAVE_AMP_MOD_SPATIAL_SCALE: f32 = ${WAVE_AMP_MOD_SPATIAL_SCALE};
const WAVE_AMP_MOD_TIME_SCALE: f32 = ${WAVE_AMP_MOD_TIME_SCALE};
const WAVE_AMP_MOD_STRENGTH: f32 = ${WAVE_AMP_MOD_STRENGTH};

// Modifier constants
const MAX_MODIFIERS: u32 = ${MAX_MODIFIERS}u;
const FLOATS_PER_MODIFIER: u32 = ${FLOATS_PER_MODIFIER}u;

// Normal computation sample offset
const NORMAL_SAMPLE_OFFSET: f32 = 1.0;

// Depth gradient sample offset (larger than normal offset for more stable gradient)
const DEPTH_GRADIENT_OFFSET: f32 = 5.0;

// Compute depth gradient using finite differences
fn computeDepthGradient(worldPos: vec2<f32>) -> vec2<f32> {
  // Sample terrain height at offset positions
  let h0 = computeTerrainHeight(
    worldPos,
    &packedTerrain,
    params.contourCount,
    params.defaultDepth
  );

  let hx = computeTerrainHeight(
    worldPos + vec2<f32>(DEPTH_GRADIENT_OFFSET, 0.0),
    &packedTerrain,
    params.contourCount,
    params.defaultDepth
  );

  let hy = computeTerrainHeight(
    worldPos + vec2<f32>(0.0, DEPTH_GRADIENT_OFFSET),
    &packedTerrain,
    params.contourCount,
    params.defaultDepth
  );

  // Depth gradient = -terrain height gradient (depth decreases as terrain rises)
  let dx = -(hx - h0) / DEPTH_GRADIENT_OFFSET;
  let dy = -(hy - h0) / DEPTH_GRADIENT_OFFSET;

  return vec2<f32>(dx, dy);
}

// Compute height at a point with per-wave shadow, terrain, and refraction
fn computeHeightAtPoint(
  worldPos: vec2<f32>,
  ampMod: f32,
  depth: f32,
  depthGradient: vec2<f32>
) -> f32 {
  // Compute per-wave energy factors and direction offsets (shadow + terrain + refraction)
  var energyFactors: array<f32, MAX_WAVE_SOURCES>;
  var directionOffsets: array<f32, MAX_WAVE_SOURCES>;
  for (var i = 0u; i < u32(params.numWaves); i++) {
    let waveDirection = waveData[i * 8u + 2u];
    let wavelength = waveData[i * 8u + 1u];

    // Shadow attenuation and diffraction
    let shadow = computeShadowForWave(worldPos, &packedShadow, i, wavelength);

    // Terrain interaction (shoaling + damping)
    let terrainFactor = computeWaveTerrainFactor(depth, wavelength);

    // Refraction (direction bending due to depth changes)
    let refractionOffset = computeRefractionOffset(
      waveDirection,
      wavelength,
      depth,
      depthGradient
    );

    energyFactors[i] = shadow.energy * terrainFactor;
    directionOffsets[i] = shadow.directionOffset + refractionOffset;
  }

  // Calculate Gerstner waves with per-wave energy factors and direction bending
  let waveResult = calculateGerstnerWaves(
    worldPos,
    params.time,
    &waveData,
    i32(params.numWaves),
    GERSTNER_STEEPNESS,
    energyFactors,
    directionOffsets,
    ampMod,
  );

  return waveResult.x + params.tideHeight;
}

// Compute normal using finite differences
// Uses same depth and depth gradient for all samples (approximation)
fn computeNormal(
  worldPos: vec2<f32>,
  ampMod: f32,
  depth: f32,
  depthGradient: vec2<f32>
) -> vec2<f32> {
  let h0 = computeHeightAtPoint(worldPos, ampMod, depth, depthGradient);
  let hx = computeHeightAtPoint(
    worldPos + vec2<f32>(NORMAL_SAMPLE_OFFSET, 0.0),
    ampMod,
    depth,
    depthGradient
  );
  let hy = computeHeightAtPoint(
    worldPos + vec2<f32>(0.0, NORMAL_SAMPLE_OFFSET),
    ampMod,
    depth,
    depthGradient
  );

  let dx = (hx - h0) / NORMAL_SAMPLE_OFFSET;
  let dy = (hy - h0) / NORMAL_SAMPLE_OFFSET;

  // Handle flat surface (no waves) - return up-facing normal
  let gradientLen = dx * dx + dy * dy;
  if (gradientLen < 0.0001) {
    return vec2<f32>(0.0, 0.0); // Flat surface, no horizontal tilt
  }

  return normalize(vec2<f32>(-dx, -dy));
}

@compute @workgroup_size(${WORKGROUP_SIZE[0]})
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let index = globalId.x;

  if (index >= params.pointCount) {
    return;
  }

  let queryPoint = pointBuffer[index];

  // Compute terrain height FIRST for depth-dependent wave calculations
  let terrainHeight = computeTerrainHeight(
    queryPoint,
    &packedTerrain,
    params.contourCount,
    params.defaultDepth
  );

  // Compute depth (mean water level minus terrain height)
  // Use tide height as approximate water level for shoaling calculation
  let depth = params.tideHeight - terrainHeight;

  // Compute depth gradient for refraction
  let depthGradient = computeDepthGradient(queryPoint);

  // Sample amplitude modulation noise
  let ampModTime = params.time * WAVE_AMP_MOD_TIME_SCALE;
  let ampMod = 1.0 + simplex3D(vec3<f32>(
    queryPoint.x * WAVE_AMP_MOD_SPATIAL_SCALE,
    queryPoint.y * WAVE_AMP_MOD_SPATIAL_SCALE,
    ampModTime
  )) * WAVE_AMP_MOD_STRENGTH;

  // Compute water height with shadow, terrain, and refraction
  let surfaceHeight = computeHeightAtPoint(queryPoint, ampMod, depth, depthGradient);

  // Compute normal (uses same depth and depth gradient for nearby samples)
  let normal = computeNormal(queryPoint, ampMod, depth, depthGradient);

  // Compute modifier contributions (wakes, ripples, currents, obstacles)
  let modifierResult = calculateModifiers(
    queryPoint.x, queryPoint.y,
    params.modifierCount, MAX_MODIFIERS,
    &modifiers, FLOATS_PER_MODIFIER
  );

  // Final surface height and depth
  let finalSurfaceHeight = surfaceHeight + modifierResult.x;
  let finalDepth = finalSurfaceHeight - terrainHeight;

  var result: WaterQueryResult;
  result.surfaceHeight = finalSurfaceHeight;
  result.velocityX = modifierResult.y;
  result.velocityY = modifierResult.z;
  result.normalX = normal.x;
  result.normalY = normal.y;
  result.depth = finalDepth;

  resultBuffer[index] = result;
}
  `,
};

/**
 * Configuration for the water query shader.
 */
export const waterQueryShaderConfig: ComputeShaderConfig = {
  modules: [waterQueryMainModule],
  workgroupSize: WORKGROUP_SIZE,
  label: "WaterQueryShader",
};

/**
 * Create a water query compute shader instance.
 */
export function createWaterQueryShader(): ComputeShader {
  return new ComputeShader(waterQueryShaderConfig);
}
