/**
 * Water Height Compute Shader
 *
 * Computes water surface height and turbulence at each pixel using Gerstner
 * waves and modifiers. Output is an rgba16float texture (R=height, G=turbulence;
 * B and A unused). rgba16float is used instead of rg16float because only the
 * former is a mandatory WebGPU storage format, and instead of rg32float because
 * fp16 precision is sufficient here and the format is filterable.
 *
 * This is the first pass of the multi-pass surface rendering pipeline.
 */

import {
  defineUniformStruct,
  f32,
  mat3x3,
  u32,
} from "../../core/graphics/UniformStruct";
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
 * Uniforms for the water height compute pass.
 */
export const WaterHeightUniforms = defineUniformStruct("Params", {
  // Clip-space → world transform for the output texture.
  // Same layout as TerrainScreenUniforms.texClipToWorld.
  texClipToWorld: mat3x3,

  // Dimensions of the output texture in texels.
  textureWidth: f32,
  textureHeight: f32,

  // Time and water params
  time: f32,
  tideHeight: f32,

  // Wave configuration (from level data)
  numWaves: u32,

  // Multiplier on Gerstner wave amplitude. 1.0 = no change. Driven from
  // `WeatherState.waveAmplitudeScale`.
  waveAmplitudeScale: f32,
});

/**
 * Params module with uniforms and bindings for water height computation.
 */
const waterHeightParamsModule: ShaderModule = {
  preamble: /*wgsl*/ `
// Water height computation parameters
struct Params {
  // clip → world for this texture (screen-aligned, rotation-aware, includes margin)
  texClipToWorld: mat3x3<f32>,
  textureWidth: f32,
  textureHeight: f32,
  time: f32,
  tideHeight: f32,
  numWaves: u32,
  waveAmplitudeScale: f32,
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
    outputTexture: { type: "storageTexture", format: "rgba16float" },
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
// Convert pixel coordinates to world position via the texture's clip→world
// matrix. Texel (x,y) center maps to clip (2*(x+0.5)/W - 1, 1 - 2*(y+0.5)/H).
fn pixelToWorld(pixel: vec2<u32>) -> vec2<f32> {
  let uv = vec2<f32>(
    (f32(pixel.x) + 0.5) / params.textureWidth,
    (f32(pixel.y) + 0.5) / params.textureHeight
  );
  let clip = vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  return (params.texClipToWorld * vec3<f32>(clip, 1.0)).xy;
}

// Calculate water height + turbulence + analytic surface gradient at a texel.
// Returns vec4(height, turbulence, dhdx, dhdy). The Gerstner gradient comes
// from the analytic derivative computed inside calculateGerstnerWaves; the
// modifier-texture contribution to the gradient comes from a 3-tap finite
// difference of the (cheap) modifier texture sample.
fn calculateWaterHeight(worldPos: vec2<f32>, pixel: vec2<u32>) -> vec4<f32> {
  // Sample wave field texture for per-wave energy, direction offset, and phase correction
  var energyFactors: array<f32, MAX_WAVE_SOURCES>;
  var directionOffsets: array<f32, MAX_WAVE_SOURCES>;
  var phaseCorrections: array<f32, MAX_WAVE_SOURCES>;

  let uv = vec2<f32>(
    (f32(pixel.x) + 0.5) / params.textureWidth,
    (f32(pixel.y) + 0.5) / params.textureHeight
  );

  var maxTurbulence = 0.0;

  for (var i = 0u; i < u32(params.numWaves); i++) {
    // Wave field texture: (phasorCos, phasorSin, unused, turbulence)
    // Uncovered pixels are (0,0,0,0) = shadow zone (zero amplitude).
    // Skirt geometry ensures open ocean areas have correct phasors from mesh triangles.
    let waveField = textureSampleLevel(waveFieldTexture, waveFieldSampler, uv, i32(i), 0.0);
    let pc = waveField.r;
    let ps = waveField.g;
    let turbulence = waveField.a;

    maxTurbulence = max(maxTurbulence, turbulence);

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
    directionOffsets[i] = 0.0;
  }

  // Amplitude modulation noise (treated as locally constant for the gradient).
  // Global weather amplitude scale is folded in here so it cascades through
  // height/dhdt/velocity uniformly.
  let ampModTime = params.time * WAVE_AMP_MOD_TIME_SCALE;
  let ampMod = (1.0 + simplex3D(vec3<f32>(
    worldPos.x * WAVE_AMP_MOD_SPATIAL_SCALE,
    worldPos.y * WAVE_AMP_MOD_SPATIAL_SCALE,
    ampModTime
  )) * WAVE_AMP_MOD_STRENGTH) * params.waveAmplitudeScale;

  // Single Gerstner evaluation — returns height, dhdt, velocity, AND the
  // analytic surface gradient (∂h/∂sampleX, ∂h/∂sampleY). Replaces the
  // previous 3-tap finite-difference (which cost 3× this evaluation).
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

  // Modifier contribution. We still want its slope captured in the surface
  // normal, so do a tiny 3-tap on the (cheap) modifier texture only — one
  // texture sample per tap, no Gerstner re-evaluation.
  // texClipToWorld[0] is the world-per-clip-x column; clip ranges [-1, 1]
  // across textureWidth texels, so 1 texel in clip is 2/textureWidth.
  let texelToWorld = vec2<f32>(
    length(params.texClipToWorld[0].xy),
    length(params.texClipToWorld[1].xy),
  ) * vec2<f32>(2.0 / params.textureWidth, 2.0 / params.textureHeight);
  let epsX = max(texelToWorld.x, 0.001);
  let epsY = max(texelToWorld.y, 0.001);
  let uvStepX = vec2<f32>(1.0 / params.textureWidth, 0.0);
  let uvStepY = vec2<f32>(0.0, -1.0 / params.textureHeight);

  let modifier0 = textureSampleLevel(modifierTexture, modifierSampler, uv, 0.0);
  let modifierX = textureSampleLevel(modifierTexture, modifierSampler, uv + uvStepX, 0.0).r;
  let modifierY = textureSampleLevel(modifierTexture, modifierSampler, uv + uvStepY, 0.0).r;

  let modifierDhdx = (modifierX - modifier0.r) / epsX;
  let modifierDhdy = (modifierY - modifier0.r) / epsY;

  let totalHeight = waveResult.height + modifier0.r + params.tideHeight;
  let totalDhdx = waveResult.dhdx + modifierDhdx;
  let totalDhdy = waveResult.dhdy + modifierDhdy;
  let totalTurbulence = max(maxTurbulence, modifier0.a);

  // Store the raw gradient components; the filter shader rebuilds the
  // unit normal via normalize(vec3(-nx, -ny, 1)).
  return vec4<f32>(totalHeight, totalTurbulence, totalDhdx, totalDhdy);
}

@compute @workgroup_size(${WORKGROUP_SIZE[0]}, ${WORKGROUP_SIZE[1]})
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let pixel = global_id.xy;

  // Bounds check
  if (pixel.x >= u32(params.textureWidth) || pixel.y >= u32(params.textureHeight)) {
    return;
  }

  let worldPos = pixelToWorld(pixel);
  let result = calculateWaterHeight(worldPos, pixel);

  // R = height, G = turbulence, B = dh/dx, A = dh/dy
  textureStore(outputTexture, pixel, result);
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
