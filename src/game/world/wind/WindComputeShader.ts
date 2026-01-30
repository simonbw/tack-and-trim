/**
 * WindComputeShader: GPU compute shader for batch wind queries.
 *
 * Computes wind velocity at multiple points in parallel using 3D simplex noise
 * for spatial and temporal variation.
 */

import { ComputeShader } from "../../../core/graphics/webgpu/ComputeShader";
import type { BindingsDefinition } from "../../../core/graphics/webgpu/ShaderBindings";
import { SIMPLEX_NOISE_3D_WGSL } from "../../../core/graphics/webgpu/WGSLSnippets";

/**
 * Bindings for wind compute shader.
 */
export const WindComputeBindings = {
  /** Query point positions (vec2f array) */
  queryPoints: { type: "storage" },
  /** Query results (f32 array: velocityX, velocityY, speed, direction for each point) */
  results: { type: "storageRW" },
  /** Wind parameters (baseWindX, baseWindY, time, padding) */
  windParams: { type: "uniform" },
  /** Noise parameters (noiseScale, timeScale, variation, padding) */
  noiseParams: { type: "uniform" },
} as const satisfies BindingsDefinition;

/**
 * GPU compute shader for batch wind queries.
 */
export class WindComputeShader extends ComputeShader<
  typeof WindComputeBindings
> {
  readonly bindings = WindComputeBindings;
  readonly workgroupSize = [64, 1] as const;

  readonly code = /* wgsl */ `
${SIMPLEX_NOISE_3D_WGSL}

// ============================================================================
// GPU Buffer Definitions
// ============================================================================

struct WindParams {
  baseWindX: f32,
  baseWindY: f32,
  time: f32,
  _padding: f32,
}

struct NoiseParams {
  noiseScale: f32,
  timeScale: f32,
  variation: f32,
  _padding: f32,
}

@group(0) @binding(0) var<storage, read> queryPoints: array<vec2f>;
@group(0) @binding(1) var<storage, read_write> results: array<f32>;
@group(0) @binding(2) var<uniform> windParams: WindParams;
@group(0) @binding(3) var<uniform> noiseParams: NoiseParams;

// ============================================================================
// Wind Computation
// ============================================================================

/**
 * Compute wind velocity at a given world position.
 * Uses 3D simplex noise (x, y, time) for smooth spatial and temporal variation.
 */
fn computeWindAt(point: vec2f) -> vec2f {
  // Sample 3D noise for temporal variation
  let noisePos = vec3f(
    point.x * noiseParams.noiseScale,
    point.y * noiseParams.noiseScale,
    windParams.time * noiseParams.timeScale
  );

  // Independent noise for X and Y components (offset to decorrelate)
  let noiseX = simplex3D(noisePos);
  let noiseY = simplex3D(noisePos + vec3f(100.0, 0.0, 0.0));

  // Apply variation: (1 + noise * variation) gives range [1-var, 1+var]
  // noise is in [-1, 1], so noise * variation is in [-var, var]
  let windX = windParams.baseWindX * (1.0 + noiseX * noiseParams.variation);
  let windY = windParams.baseWindY * (1.0 + noiseY * noiseParams.variation);

  return vec2f(windX, windY);
}

// ============================================================================
// Main Compute Shader
// ============================================================================

@compute @workgroup_size(64, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  // Bounds check
  if (id.x >= arrayLength(&queryPoints)) {
    return;
  }

  let point = queryPoints[id.x];
  let windVelocity = computeWindAt(point);
  let speed = length(windVelocity);
  let direction = atan2(windVelocity.y, windVelocity.x);

  // Pack into result buffer (stride=4: velocityX, velocityY, speed, direction)
  let offset = id.x * 4u;
  results[offset + 0u] = windVelocity.x;
  results[offset + 1u] = windVelocity.y;
  results[offset + 2u] = speed;
  results[offset + 3u] = direction;
}
`;
}
