/**
 * Water Height Compute Shader
 *
 * Computes water surface height and turbulence at each pixel using Gerstner
 * waves and modifiers. Output is a two-channel rg32float texture (R=height, G=turbulence).
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
import { fn_hash21 } from "../world/shaders/math.wgsl";
import {
  GERSTNER_STEEPNESS,
  MAX_WAVES,
  WAVE_AMP_MOD_SPATIAL_SCALE,
  WAVE_AMP_MOD_STRENGTH,
  WAVE_AMP_MOD_TIME_SCALE,
} from "../world/water/WaterConstants";

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
  _paddingMC: u32,
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

// Breaking zone turbulence
const BREAK_PHASE_NOISE_STRENGTH: f32 = 0.8;
const BREAK_AMP_NOISE_STRENGTH: f32 = 0.15;
const BREAK_NOISE_SPATIAL_SCALE: f32 = 0.3;
const BREAK_NOISE_TIME_SCALE: f32 = 1.2;

`,
  bindings: {
    params: { type: "uniform", wgslType: "Params" },
    waveData: { type: "storage", wgslType: "array<f32>" },
    modifierTexture: {
      type: "texture",
      viewDimension: "2d",
      sampleType: "float",
    },
    modifierSampler: { type: "sampler" },
    waveFieldTexture: {
      type: "texture",
      viewDimension: "2d-array",
      sampleType: "float",
    },
    waveFieldSampler: { type: "sampler" },
    outputTexture: { type: "storageTexture", format: "rg32float" },
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

// Calculate water height and turbulence at a point using wave field texture
fn calculateWaterHeight(worldPos: vec2<f32>, pixel: vec2<u32>) -> vec2<f32> {
  // Sample wave field texture for per-wave energy, direction offset, and phase correction
  var energyFactors: array<f32, MAX_WAVE_SOURCES>;
  var directionOffsets: array<f32, MAX_WAVE_SOURCES>;
  var phaseCorrections: array<f32, MAX_WAVE_SOURCES>;

  let uv = vec2<f32>(
    (f32(pixel.x) + 0.5) / params.screenWidth,
    (f32(pixel.y) + 0.5) / params.screenHeight
  );

  var maxTurbulence = 0.0;

  for (var i = 0u; i < u32(params.numWaves); i++) {
    let waveField = textureSampleLevel(waveFieldTexture, waveFieldSampler, uv, i32(i), 0.0);
    let pc = waveField.r;
    let ps = waveField.g;
    let coverage = waveField.b;
    let turbulence = waveField.a;

    maxTurbulence = max(maxTurbulence, turbulence);

    if (coverage > 0.0) {
      let mag = sqrt(pc * pc + ps * ps);
      energyFactors[i] = mag;
      // Avoid atan2(0, 0) which is undefined on GPU — can produce NaN
      if (mag > 0.001) {
        phaseCorrections[i] = atan2(ps, pc);
      } else {
        phaseCorrections[i] = 0.0;
      }

      // Breaking zone turbulence: add per-wave-source noise for chaotic breaking
      if (turbulence > 0.0) {
        let waveSeed = f32(i) * 17.31;
        let breakPhaseNoise = simplex3D(vec3<f32>(
          worldPos.x * BREAK_NOISE_SPATIAL_SCALE,
          worldPos.y * BREAK_NOISE_SPATIAL_SCALE,
          params.time * BREAK_NOISE_TIME_SCALE + waveSeed
        ));
        phaseCorrections[i] += turbulence * breakPhaseNoise * BREAK_PHASE_NOISE_STRENGTH;

        let breakAmpNoise = simplex3D(vec3<f32>(
          worldPos.x * BREAK_NOISE_SPATIAL_SCALE * 1.7 + 100.0,
          worldPos.y * BREAK_NOISE_SPATIAL_SCALE * 1.7 + 100.0,
          params.time * BREAK_NOISE_TIME_SCALE * 0.8 + waveSeed + 50.0
        ));
        energyFactors[i] *= 1.0 + turbulence * breakAmpNoise * BREAK_AMP_NOISE_STRENGTH;
      }
    } else {
      energyFactors[i] = 1.0;
      phaseCorrections[i] = 0.0;
    }
    directionOffsets[i] = 0.0;
  }

  // Sample amplitude modulation noise
  let ampModTime = params.time * WAVE_AMP_MOD_TIME_SCALE;
  let ampMod = 1.0 + simplex3D(vec3<f32>(
    worldPos.x * WAVE_AMP_MOD_SPATIAL_SCALE,
    worldPos.y * WAVE_AMP_MOD_SPATIAL_SCALE,
    ampModTime
  )) * WAVE_AMP_MOD_STRENGTH;

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

  // Sample modifier texture (rasterized in a prior pass)
  let modifierSample = textureSampleLevel(modifierTexture, modifierSampler, uv, 0.0);
  let modifierHeight = modifierSample.r;
  let modifierTurbulence = modifierSample.a;

  // Combined height = waves + modifiers + tide
  let height = waveResult.x + modifierHeight + params.tideHeight;
  // Combine wave breaking turbulence with modifier turbulence (e.g. wake foam)
  let totalTurbulence = max(maxTurbulence, modifierTurbulence);
  return vec2<f32>(height, totalTurbulence);
}

@compute @workgroup_size(${WORKGROUP_SIZE[0]}, ${WORKGROUP_SIZE[1]})
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let pixel = global_id.xy;

  // Bounds check
  if (pixel.x >= u32(params.screenWidth) || pixel.y >= u32(params.screenHeight)) {
    return;
  }

  let worldPos = pixelToWorld(pixel);

  // Calculate water height and turbulence using wave field texture
  let result = calculateWaterHeight(worldPos, pixel);

  // Write to output texture (R = height, G = turbulence)
  textureStore(outputTexture, pixel, vec4<f32>(result.x, result.y, 0.0, 0.0));
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
