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
  // clip → world for this texture (screen-aligned, rotation-aware, includes margin)
  texClipToWorld: mat3x3<f32>,
  textureWidth: f32,
  textureHeight: f32,
  time: f32,
  tideHeight: f32,
  numWaves: u32,
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

// Helper: evaluate total water surface height at an arbitrary world point.
// Wave-field corrections are sampled once per pixel and reused for the 3
// neighbor evaluations below — terrain influence varies smoothly enough at
// our texel scale that treating it as locally constant is safe and avoids
// 3× the wave-field samples.
fn evaluateHeight(
  worldPos: vec2<f32>,
  uv: vec2<f32>,
  energyFactors: array<f32, MAX_WAVE_SOURCES>,
  directionOffsets: array<f32, MAX_WAVE_SOURCES>,
  phaseCorrections: array<f32, MAX_WAVE_SOURCES>,
  ampMod: f32,
) -> f32 {
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
  let modifierSample = textureSampleLevel(modifierTexture, modifierSampler, uv, 0.0);
  return waveResult.x + modifierSample.r + params.tideHeight;
}

// Calculate water height + turbulence + analytic surface normal at a texel.
// Returns vec4(height, turbulence, normalX, normalY). Computing the normal
// here (via 3-tap world-space finite difference of the wave evaluator)
// instead of bilinear-sampling height in the filter shader avoids the
// texel-grid facet artifacts that piecewise-linear bilinear interpolation
// produces in the specular highlight.
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
  let ampModTime = params.time * WAVE_AMP_MOD_TIME_SCALE;
  let ampMod = 1.0 + simplex3D(vec3<f32>(
    worldPos.x * WAVE_AMP_MOD_SPATIAL_SCALE,
    worldPos.y * WAVE_AMP_MOD_SPATIAL_SCALE,
    ampModTime
  )) * WAVE_AMP_MOD_STRENGTH;

  // World-space finite-difference step. One texel wide in world coords —
  // matches the spatial resolution we'd otherwise get from sampling the
  // height texture, but evaluated *exactly* at the offset position so
  // there's no piecewise-linear bilinear quirk.
  //
  // texClipToWorld[0] is the world-per-clip-x column; clip ranges [-1, 1]
  // across textureWidth texels, so 1 texel in clip is 2/textureWidth.
  let texelToWorld = vec2<f32>(
    length(params.texClipToWorld[0].xy),
    length(params.texClipToWorld[1].xy),
  ) * vec2<f32>(2.0 / params.textureWidth, 2.0 / params.textureHeight);
  let epsX = max(texelToWorld.x, 0.001);
  let epsY = max(texelToWorld.y, 0.001);

  // Modifier UV step matches the world step. The modifier texture is at
  // half resolution; bilinear sampling smooths it across our small offset.
  let uvStepX = vec2<f32>(epsX / length(params.texClipToWorld[0].xy) * 0.5, 0.0);
  let uvStepY = vec2<f32>(0.0, -epsY / length(params.texClipToWorld[1].xy) * 0.5);

  let h0 = evaluateHeight(worldPos, uv, energyFactors, directionOffsets, phaseCorrections, ampMod);
  let hX = evaluateHeight(worldPos + vec2<f32>(epsX, 0.0), uv + uvStepX, energyFactors, directionOffsets, phaseCorrections, ampMod);
  let hY = evaluateHeight(worldPos + vec2<f32>(0.0, epsY), uv + uvStepY, energyFactors, directionOffsets, phaseCorrections, ampMod);

  let dhdx = (hX - h0) / epsX;
  let dhdy = (hY - h0) / epsY;

  // Sample modifier turbulence at center (only need it for the .a channel).
  let modifierSample = textureSampleLevel(modifierTexture, modifierSampler, uv, 0.0);
  let totalTurbulence = max(maxTurbulence, modifierSample.a);

  // Store the raw gradient components; the filter shader rebuilds the
  // unit normal via normalize(vec3(-nx, -ny, 1)).
  return vec4<f32>(h0, totalTurbulence, dhdx, dhdy);
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
