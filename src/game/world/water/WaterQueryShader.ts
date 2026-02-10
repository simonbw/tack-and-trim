/**
 * Water Query Compute Shader
 *
 * Samples water data (height, velocity, normals, depth) at arbitrary query points.
 * Uses the same modular shader code as the water state shader.
 * Includes modifier support for wakes, ripples, currents, and obstacles.
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
import { fn_lookupMeshForWave } from "../shaders/mesh-packed.wgsl";
import { fn_simplex3D } from "../shaders/noise.wgsl";
import {
  fn_computeTerrainHeight,
  struct_ContourData,
} from "../shaders/terrain.wgsl";
import { fn_calculateModifiers } from "../shaders/water-modifiers.wgsl";
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
    packedMesh: { type: "storage", wgslType: "array<u32>" },
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
    fn_lookupMeshForWave,
    fn_computeTerrainHeight,
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

// Compute height at a point using mesh lookup for per-wave data
fn computeHeightAtPoint(
  worldPos: vec2<f32>,
  ampMod: f32,
) -> f32 {
  // Look up per-wave energy factors, direction offsets, and phase corrections from mesh
  var energyFactors: array<f32, MAX_WAVE_SOURCES>;
  var directionOffsets: array<f32, MAX_WAVE_SOURCES>;
  var phaseCorrections: array<f32, MAX_WAVE_SOURCES>;
  for (var i = 0u; i < u32(params.numWaves); i++) {
    let meshResult = lookupMeshForWave(worldPos, &packedMesh, i);
    energyFactors[i] = mix(1.0, meshResult.amplitudeFactor, meshResult.blendWeight);
    directionOffsets[i] = mix(0.0, meshResult.directionOffset, meshResult.blendWeight);
    phaseCorrections[i] = mix(0.0, meshResult.phaseOffset, meshResult.blendWeight);
  }

  // Calculate Gerstner waves with per-wave energy factors, direction bending, and phase corrections
  let waveResult = calculateGerstnerWaves(
    worldPos,
    params.time,
    &waveData,
    i32(params.numWaves),
    GERSTNER_STEEPNESS,
    energyFactors,
    directionOffsets,
    phaseCorrections,
    ampMod,
  );

  return waveResult.x + params.tideHeight;
}

// Compute normal using finite differences
fn computeNormal(
  worldPos: vec2<f32>,
  ampMod: f32,
) -> vec2<f32> {
  let h0 = computeHeightAtPoint(worldPos, ampMod);
  let hx = computeHeightAtPoint(
    worldPos + vec2<f32>(NORMAL_SAMPLE_OFFSET, 0.0),
    ampMod,
  );
  let hy = computeHeightAtPoint(
    worldPos + vec2<f32>(0.0, NORMAL_SAMPLE_OFFSET),
    ampMod,
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

  // Compute terrain height for depth result
  let terrainHeight = computeTerrainHeight(
    queryPoint,
    &packedTerrain,
    params.contourCount,
    params.defaultDepth
  );

  // Sample amplitude modulation noise
  let ampModTime = params.time * WAVE_AMP_MOD_TIME_SCALE;
  let ampMod = 1.0 + simplex3D(vec3<f32>(
    queryPoint.x * WAVE_AMP_MOD_SPATIAL_SCALE,
    queryPoint.y * WAVE_AMP_MOD_SPATIAL_SCALE,
    ampModTime
  )) * WAVE_AMP_MOD_STRENGTH;

  // Compute water height using mesh lookup
  let surfaceHeight = computeHeightAtPoint(queryPoint, ampMod);

  // Compute normal
  let normal = computeNormal(queryPoint, ampMod);

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
