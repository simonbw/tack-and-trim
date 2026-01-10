// Wave Compute Shader
// Computes Gerstner waves with simplex noise modulation
// Output: rgba16float storage texture with height and dh/dt

// Note: Constants are interpolated from TypeScript at build time
// See WaveComputeGPU.ts for the complete shader with constants

const PI: f32 = 3.14159265359;
// const NUM_WAVES: i32 = 12;
// const GERSTNER_STEEPNESS: f32 = 0.7;
// const GRAVITY: f32 = 32.15;  // ft/s^2
// const WAVE_AMP_MOD_SPATIAL_SCALE: f32 = 0.005;
// const WAVE_AMP_MOD_TIME_SCALE: f32 = 0.015;
// const WAVE_AMP_MOD_STRENGTH: f32 = 0.5;

struct Params {
  time: f32,
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  textureSizeX: f32,
  textureSizeY: f32,
  _padding: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> waveData: array<f32>;
@group(0) @binding(2) var outputTexture: texture_storage_2d<rgba16float, write>;

// ============================================================================
// Simplex 3D Noise
// ============================================================================

fn mod289_3(x: vec3<f32>) -> vec3<f32> {
  return x - floor(x * (1.0 / 289.0)) * 289.0;
}

fn mod289_4(x: vec4<f32>) -> vec4<f32> {
  return x - floor(x * (1.0 / 289.0)) * 289.0;
}

fn permute(x: vec4<f32>) -> vec4<f32> {
  return mod289_4(((x * 34.0) + 10.0) * x);
}

fn taylorInvSqrt(r: vec4<f32>) -> vec4<f32> {
  return 1.79284291400159 - 0.85373472095314 * r;
}

fn simplex3D(v: vec3<f32>) -> f32 {
  // Full simplex noise implementation
  // See WaveComputeGPU.ts for complete code
  return 0.0;
}

// ============================================================================
// Hash function for white noise
// ============================================================================

fn hash2D(x: f32, y: f32) -> f32 {
  let n = sin(x * 127.1 + y * 311.7) * 43758.5453;
  return fract(n);
}

// ============================================================================
// Gerstner Wave Calculation
// ============================================================================
//
// Two-pass algorithm:
// 1. Compute horizontal displacement from all waves
// 2. Sample height at displaced position
//
// Wave data format (8 floats per wave):
// [amplitude, wavelength, direction, phaseOffset, speedMult, sourceDist, offsetX, offsetY]

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let texSize = vec2<f32>(params.textureSizeX, params.textureSizeY);

  if (f32(globalId.x) >= texSize.x || f32(globalId.y) >= texSize.y) {
    return;
  }

  let uv = vec2<f32>(f32(globalId.x) + 0.5, f32(globalId.y) + 0.5) / texSize;

  let worldPos = vec2<f32>(
    params.viewportLeft + uv.x * params.viewportWidth,
    params.viewportTop + uv.y * params.viewportHeight
  );

  // Calculate waves (full implementation in WaveComputeGPU.ts)
  let height = 0.0;
  let dhdt = 0.0;

  // Normalize and store
  let normalizedHeight = height / 5.0 + 0.5;
  let normalizedDhdt = dhdt / 10.0 + 0.5;

  textureStore(outputTexture, vec2<i32>(globalId.xy), vec4<f32>(normalizedHeight, normalizedDhdt, 0.5, 1.0));
}
