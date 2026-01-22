/**
 * Wind state compute shader.
 *
 * Extends ComputeShader base class to compute wind velocity field.
 * Implements base wind velocity with simplex noise variation.
 *
 * Output format (rg32float):
 * - R: Normalized velocity X (velocityX / WIND_VELOCITY_SCALE + 0.5)
 * - G: Normalized velocity Y (velocityY / WIND_VELOCITY_SCALE + 0.5)
 */

import { ComputeShader } from "../../../../core/graphics/webgpu/ComputeShader";
import { SIMPLEX_NOISE_3D_WGSL } from "../../../../core/graphics/webgpu/WGSLSnippets";
import {
  WIND_ANGLE_VARIATION,
  WIND_NOISE_SPATIAL_SCALE,
  WIND_NOISE_TIME_SCALE,
  WIND_SPEED_VARIATION,
  WIND_VELOCITY_SCALE,
} from "../WindConstants";

const bindings = {
  params: { type: "uniform" },
  outputTexture: { type: "storageTexture", format: "rg32float" },
} as const;

/**
 * Wind state compute shader using the ComputeShader base class.
 */
export class WindStateShader extends ComputeShader<typeof bindings> {
  readonly bindings = bindings;
  readonly workgroupSize = [8, 8] as const;

  readonly code = /*wgsl*/ `
// Constants
const PI: f32 = 3.14159265359;
const WIND_NOISE_SPATIAL_SCALE: f32 = ${WIND_NOISE_SPATIAL_SCALE};
const WIND_NOISE_TIME_SCALE: f32 = ${WIND_NOISE_TIME_SCALE};
const WIND_SPEED_VARIATION: f32 = ${WIND_SPEED_VARIATION};
const WIND_ANGLE_VARIATION: f32 = ${WIND_ANGLE_VARIATION};
const WIND_VELOCITY_SCALE: f32 = ${WIND_VELOCITY_SCALE};

struct Params {
  time: f32,
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  textureSizeX: f32,
  textureSizeY: f32,
  _padding: f32,
  // Base wind direction and speed
  baseWindX: f32,
  baseWindY: f32,
  _padding2: f32,
  _padding3: f32,
  // Terrain influence parameters
  influenceSpeedFactor: f32,
  influenceDirectionOffset: f32,
  influenceTurbulence: f32,
  _padding4: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var outputTexture: texture_storage_2d<rg32float, write>;

// Simplex 3D Noise
${SIMPLEX_NOISE_3D_WGSL}

// ============================================================================
// Wind calculation
// ============================================================================

fn calculateWindVelocity(worldPos: vec2<f32>, time: f32) -> vec2<f32> {
  let x = worldPos.x;
  let y = worldPos.y;

  let t = time * WIND_NOISE_TIME_SCALE;
  let sx = x * WIND_NOISE_SPATIAL_SCALE;
  let sy = y * WIND_NOISE_SPATIAL_SCALE;

  // Sample noise for speed and angle variation
  // Use offset coordinates for angle noise to get independent variation
  let speedNoise = simplex3D(vec3<f32>(sx, sy, t));
  let angleNoise = simplex3D(vec3<f32>(sx + 1000.0, sy + 1000.0, t));

  // Apply terrain influence to speed variation (turbulence boosts noise)
  let turbulenceBoost = 1.0 + params.influenceTurbulence * 0.5;
  var speedScale = 1.0 + speedNoise * WIND_SPEED_VARIATION * turbulenceBoost;
  speedScale *= params.influenceSpeedFactor; // Apply terrain blocking/acceleration

  // Apply influence direction offset + noise angle
  let totalAngleOffset = angleNoise * WIND_ANGLE_VARIATION + params.influenceDirectionOffset;

  // Apply speed scale to base wind
  let scaledX = params.baseWindX * speedScale;
  let scaledY = params.baseWindY * speedScale;

  // Rotate by total angle offset
  let cosAngle = cos(totalAngleOffset);
  let sinAngle = sin(totalAngleOffset);
  let velocityX = scaledX * cosAngle - scaledY * sinAngle;
  let velocityY = scaledX * sinAngle + scaledY * cosAngle;

  return vec2<f32>(velocityX, velocityY);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let texSize = vec2<f32>(params.textureSizeX, params.textureSizeY);

  // Check bounds
  if (f32(globalId.x) >= texSize.x || f32(globalId.y) >= texSize.y) {
    return;
  }

  // Convert pixel coords to UV (0-1)
  let uv = vec2<f32>(f32(globalId.x) + 0.5, f32(globalId.y) + 0.5) / texSize;

  // Map UV to world position
  let worldPos = vec2<f32>(
    params.viewportLeft + uv.x * params.viewportWidth,
    params.viewportTop + uv.y * params.viewportHeight
  );

  // Calculate wind velocity
  let velocity = calculateWindVelocity(worldPos, params.time);

  // Normalize output to 0-1 range
  let normalizedVel = velocity / WIND_VELOCITY_SCALE + vec2<f32>(0.5, 0.5);

  textureStore(outputTexture, vec2<i32>(globalId.xy), vec4<f32>(normalizedVel.x, normalizedVel.y, 0.0, 0.0));
}
`;
}
