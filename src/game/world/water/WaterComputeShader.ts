import { ComputeShader } from "../../../core/graphics/webgpu/ComputeShader";
import type { BindingsDefinition } from "../../../core/graphics/webgpu/ShaderBindings";

/**
 * GPU bindings for water query computation
 */
export const WaterComputeBindings = {
  /** Input: Query point positions (vec2f array) */
  queryPoints: { type: "storage" },
  /** Output: Query results (f32 array, stride=6 per point) */
  results: { type: "storageRW" },
  /** Wave source data (WaveSource array) */
  waveSources: { type: "storage" },
  /** Uniform parameters: time, waveCount */
  waterParams: { type: "uniform" },
} as const satisfies BindingsDefinition;

/**
 * WGSL compute shader for batch water queries using Gerstner waves.
 *
 * This shader implements a two-pass Gerstner wave evaluation:
 * 1. First pass: Accumulate horizontal displacement from all waves
 * 2. Second pass: Evaluate wave height/velocity at the displaced position
 *
 * This two-pass approach produces more realistic wave shapes than simple
 * sine wave summation, as water particles move in elliptical orbits.
 */
const WATER_COMPUTE_SHADER = /* wgsl */ `

struct WaveSource {
  direction: vec2f,    // Unit direction vector
  amplitude: f32,      // Wave amplitude in meters
  k: f32,             // Wave number (2π / wavelength)
  omega: f32,         // Angular frequency
  _padding: vec3f,    // Alignment padding
}

struct WaterParams {
  time: f32,
  waveCount: f32,
  _padding: vec2f,
}

@group(0) @binding(0) var<storage, read> queryPoints: array<vec2f>;
@group(0) @binding(1) var<storage, read_write> results: array<f32>;
@group(0) @binding(2) var<storage, read> waveSources: array<WaveSource>;
@group(0) @binding(3) var<uniform> waterParams: WaterParams;

/**
 * Compute horizontal displacement from a single Gerstner wave
 */
fn gerstnerDisplacement(wave: WaveSource, pos: vec2f, time: f32) -> vec2f {
  let phase = wave.k * dot(pos, wave.direction) - wave.omega * time;
  let displacementMag = (wave.amplitude / wave.k) * cos(phase);
  return wave.direction * displacementMag;
}

/**
 * Evaluate wave height and vertical velocity at a position
 */
fn evaluateWave(wave: WaveSource, pos: vec2f, time: f32) -> vec2f {
  let phase = wave.k * dot(pos, wave.direction) - wave.omega * time;
  return vec2f(
    wave.amplitude * sin(phase),           // z (height)
    -wave.amplitude * wave.omega * cos(phase)  // vz (vertical velocity)
  );
}

/**
 * Helper: Compute total wave height at a position (for gradient calculation)
 */
fn heightAt(pos: vec2f, time: f32) -> f32 {
  var totalHeight = 0.0;
  let count = u32(waterParams.waveCount);
  for (var i = 0u; i < count; i++) {
    let wave = waveSources[i];
    let phase = wave.k * dot(pos, wave.direction) - wave.omega * time;
    totalHeight += wave.amplitude * sin(phase);
  }
  return totalHeight;
}

/**
 * Main compute kernel - evaluates water properties at each query point
 *
 * Output format (6 floats per point):
 *   [0]: surfaceHeight (m)
 *   [1-2]: velocity (m/s, x and y) [MVP: zeros]
 *   [3-4]: normal (unit vector, x and y pointing "upslope")
 *   [5]: depth (m) [MVP: zero]
 */
@compute @workgroup_size(64, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let pointIndex = id.x;
  if (pointIndex >= arrayLength(&queryPoints)) {
    return;
  }

  let point = queryPoints[pointIndex];
  let time = waterParams.time;

  // PASS 1: Accumulate horizontal displacement from all waves
  let waveCount = u32(waterParams.waveCount);
  var displacement = vec2f(0.0);
  for (var i = 0u; i < waveCount; i++) {
    displacement += gerstnerDisplacement(waveSources[i], point, time);
  }

  let displacedPos = point + displacement;

  // PASS 2: Evaluate height and vertical velocity at displaced position
  var totalZ = 0.0;
  var totalVz = 0.0;
  for (var i = 0u; i < waveCount; i++) {
    let result = evaluateWave(waveSources[i], displacedPos, time);
    totalZ += result.x;   // height
    totalVz += result.y;  // vertical velocity
  }

  // Compute surface normal using numerical gradient
  // Normal points "upslope" (toward higher water)
  let epsilon = 0.1;
  let gradX = (heightAt(displacedPos + vec2f(epsilon, 0.0), time) -
               heightAt(displacedPos - vec2f(epsilon, 0.0), time)) / (2.0 * epsilon);
  let gradY = (heightAt(displacedPos + vec2f(0.0, epsilon), time) -
               heightAt(displacedPos - vec2f(0.0, epsilon), time)) / (2.0 * epsilon);

  // Normal is perpendicular to gradient, pointing upslope
  // Handle zero gradient case (flat water) by defaulting to (0, 1)
  let gradVec = vec2f(-gradX, -gradY);
  let gradLength = length(gradVec);
  let normal = select(vec2f(0.0, 1.0), gradVec / gradLength, gradLength > 0.0001);

  // Pack results into output buffer (stride = 6 floats per point)
  let offset = pointIndex * 6u;
  results[offset + 0u] = totalZ;        // surfaceHeight
  results[offset + 1u] = 0.0;           // velocityX (stub for MVP)
  results[offset + 2u] = 0.0;           // velocityY (stub for MVP)
  results[offset + 3u] = normal.x;      // normalX
  results[offset + 4u] = normal.y;      // normalY
  results[offset + 5u] = 0.0;           // depth (stub for MVP)
}
`;

/**
 * Compute shader for GPU-accelerated water queries using Gerstner waves.
 * Follows the same pattern as TerrainQueryCompute and WindComputeShader.
 */
export class WaterComputeShader extends ComputeShader<
  typeof WaterComputeBindings
> {
  readonly bindings = WaterComputeBindings;
  readonly workgroupSize = [64, 1] as const;
  readonly code = WATER_COMPUTE_SHADER;
}
