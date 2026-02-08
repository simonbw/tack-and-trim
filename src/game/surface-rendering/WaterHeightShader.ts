/**
 * Water Height Compute Shader
 *
 * Computes water surface height at each pixel using Gerstner waves and modifiers.
 * Output is a single-channel r32float texture containing world-space water height.
 *
 * This is the first pass of the multi-pass surface rendering pipeline.
 */

import {
  ComputeShader,
  type ComputeShaderConfig,
} from "../../core/graphics/webgpu/ComputeShader";
import type { ShaderModule } from "../../core/graphics/webgpu/ShaderModule";
import { fn_calculateGerstnerWaves } from "../world/shaders/gerstner-wave.wgsl";
import { fn_simplex3D } from "../world/shaders/noise.wgsl";
import { fn_calculateModifiers } from "../world/shaders/water-modifiers.wgsl";
import { fn_hash21 } from "../world/shaders/math.wgsl";
import { fn_computeShadowForWave } from "../world/shaders/shadow-attenuation.wgsl";
import { fn_computeWaveTerrainFactor } from "../world/shaders/wave-terrain.wgsl";
import { fn_computeRefractionOffset } from "../world/shaders/wave-physics.wgsl";
import {
  GERSTNER_STEEPNESS,
  MAX_WAVES,
  WAVE_AMP_MOD_SPATIAL_SCALE,
  WAVE_AMP_MOD_STRENGTH,
  WAVE_AMP_MOD_TIME_SCALE,
} from "../world/water/WaterConstants";
import {
  FLOATS_PER_MODIFIER,
  MAX_MODIFIERS,
} from "../world/water/WaterResources";

const WORKGROUP_SIZE = [8, 8] as const;

/**
 * Params module with uniforms and bindings for water height computation.
 */
const waterHeightParamsModule: ShaderModule = {
  preamble: /*wgsl*/ `
// Water height computation parameters
struct Params {
  screenWidth: f32,
  screenHeight: f32,
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  time: f32,
  tideHeight: f32,
  modifierCount: u32,
  numWaves: u32,
  _padding0: u32,
  _padding1: u32,
  _padding2: u32,
  _padding3: u32,
}

// Wave computation constants
const MAX_WAVES: i32 = ${MAX_WAVES};
const GERSTNER_STEEPNESS: f32 = ${GERSTNER_STEEPNESS};
const WAVE_AMP_MOD_SPATIAL_SCALE: f32 = ${WAVE_AMP_MOD_SPATIAL_SCALE};
const WAVE_AMP_MOD_TIME_SCALE: f32 = ${WAVE_AMP_MOD_TIME_SCALE};
const WAVE_AMP_MOD_STRENGTH: f32 = ${WAVE_AMP_MOD_STRENGTH};

// Modifier constants
const MAX_MODIFIERS: u32 = ${MAX_MODIFIERS}u;
const FLOATS_PER_MODIFIER: u32 = ${FLOATS_PER_MODIFIER}u;
`,
  bindings: {
    params: { type: "uniform", wgslType: "Params" },
    waveData: { type: "storage", wgslType: "array<f32>" },
    modifiers: { type: "storage", wgslType: "array<f32>" },
    packedShadow: { type: "storage", wgslType: "array<u32>" },
    terrainHeightTexture: {
      type: "texture",
      viewDimension: "2d",
      sampleType: "unfilterable-float",
    },
    outputTexture: { type: "storageTexture", format: "r32float" },
  },
  code: "",
};

/**
 * Main compute module for water height.
 */
const waterHeightComputeModule: ShaderModule = {
  dependencies: [
    waterHeightParamsModule,
    fn_hash21,
    fn_simplex3D,
    fn_calculateGerstnerWaves,
    fn_calculateModifiers,
    fn_computeShadowForWave,
    fn_computeWaveTerrainFactor,
    fn_computeRefractionOffset,
  ],
  code: /*wgsl*/ `
// Convert pixel coordinates to world position
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

// Sample terrain height from screen-space texture
fn sampleTerrainHeight(pixel: vec2<u32>) -> f32 {
  return textureLoad(terrainHeightTexture, vec2<i32>(pixel), 0).r;
}

// Depth gradient sample offset (in pixels)
const DEPTH_GRADIENT_OFFSET_PX: i32 = 5;

// Compute depth gradient using finite differences on terrain texture
fn computeDepthGradient(pixel: vec2<u32>, terrainHeight: f32) -> vec2<f32> {
  // Sample nearby terrain heights
  let hx = textureLoad(
    terrainHeightTexture,
    vec2<i32>(i32(pixel.x) + DEPTH_GRADIENT_OFFSET_PX, i32(pixel.y)),
    0
  ).r;
  let hy = textureLoad(
    terrainHeightTexture,
    vec2<i32>(i32(pixel.x), i32(pixel.y) + DEPTH_GRADIENT_OFFSET_PX),
    0
  ).r;

  // Convert pixel offset to world space offset
  let worldOffsetX = (params.viewportWidth / params.screenWidth) * f32(DEPTH_GRADIENT_OFFSET_PX);
  let worldOffsetY = (params.viewportHeight / params.screenHeight) * f32(DEPTH_GRADIENT_OFFSET_PX);

  // Depth gradient = -terrain height gradient
  let dx = -(hx - terrainHeight) / worldOffsetX;
  let dy = -(hy - terrainHeight) / worldOffsetY;

  return vec2<f32>(dx, dy);
}

// Calculate water height at a point with per-wave shadow, terrain, and refraction
fn calculateWaterHeight(worldPos: vec2<f32>, depth: f32, depthGradient: vec2<f32>) -> f32 {
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

  // Sample amplitude modulation noise
  let ampModTime = params.time * WAVE_AMP_MOD_TIME_SCALE;
  let ampMod = 1.0 + simplex3D(vec3<f32>(
    worldPos.x * WAVE_AMP_MOD_SPATIAL_SCALE,
    worldPos.y * WAVE_AMP_MOD_SPATIAL_SCALE,
    ampModTime
  )) * WAVE_AMP_MOD_STRENGTH;

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

  // Calculate modifier contributions (wakes, etc.)
  let modifierResult = calculateModifiers(
    worldPos.x,
    worldPos.y,
    params.modifierCount,
    MAX_MODIFIERS,
    &modifiers,
    FLOATS_PER_MODIFIER
  );

  // Combined height = waves + modifiers + tide
  return waveResult.x + modifierResult.x + params.tideHeight;
}

@compute @workgroup_size(${WORKGROUP_SIZE[0]}, ${WORKGROUP_SIZE[1]})
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let pixel = global_id.xy;

  // Bounds check
  if (pixel.x >= u32(params.screenWidth) || pixel.y >= u32(params.screenHeight)) {
    return;
  }

  let worldPos = pixelToWorld(pixel);

  // Sample terrain height and compute depth for terrain interaction
  let terrainHeight = sampleTerrainHeight(pixel);
  let waterLevel = params.tideHeight; // Mean water level
  let depth = waterLevel - terrainHeight;

  // Compute depth gradient for refraction
  let depthGradient = computeDepthGradient(pixel, terrainHeight);

  // Calculate water height with shoaling/damping/refraction based on depth
  let height = calculateWaterHeight(worldPos, depth, depthGradient);

  // Write to output texture
  textureStore(outputTexture, pixel, vec4<f32>(height, 0.0, 0.0, 0.0));
}
`,
};

const waterHeightShaderConfig: ComputeShaderConfig = {
  modules: [waterHeightComputeModule],
  workgroupSize: WORKGROUP_SIZE,
  label: "WaterHeightShader",
};

export function createWaterHeightShader(): ComputeShader {
  return new ComputeShader(waterHeightShaderConfig);
}
