/**
 * Unified water state compute shader.
 *
 * Extends ComputeShader base class to compute water state combining:
 * - Gerstner wave simulation with simplex noise modulation
 * - Wake modifier contributions from boat wakes
 *
 * Output format (rgba32float):
 * - R: Combined height (waves + modifiers), normalized
 * - G: dh/dt (rate of height change), normalized
 * - B: Water velocity X (from modifiers), normalized
 * - A: Water velocity Y (from modifiers), normalized
 */

import { ComputeShader } from "../../../../core/graphics/webgpu/ComputeShader";
import { SIMPLEX_NOISE_3D_WGSL } from "../../../../core/graphics/webgpu/WGSLSnippets";
import {
  NUM_WAVES,
  GERSTNER_STEEPNESS,
  GRAVITY_FT_PER_S2,
  WAVE_AMP_MOD_SPATIAL_SCALE,
  WAVE_AMP_MOD_TIME_SCALE,
  WAVE_AMP_MOD_STRENGTH,
  WATER_HEIGHT_SCALE,
  WATER_VELOCITY_SCALE,
  SWELL_WAVE_COUNT,
} from "../WaterConstants";
import { MAX_SEGMENTS, FLOATS_PER_SEGMENT } from "./WaterComputeBuffers";

// Constants for modifier computation
const HEIGHT_SCALE = 0.5;
const WATER_VELOCITY_FACTOR = 0.0; // Set to non-zero to enable velocity from wakes

const bindings = {
  params: { type: "uniform" },
  waveData: { type: "storage" },
  segments: { type: "storage" },
  outputTexture: { type: "storageTexture", format: "rgba32float" },
} as const;

/**
 * Water state compute shader using the ComputeShader base class.
 */
export class WaterStateShader extends ComputeShader<typeof bindings> {
  readonly bindings = bindings;
  readonly workgroupSize = [8, 8] as const;

  readonly code = /*wgsl*/ `
// ============================================================================
// Constants
// ============================================================================
const PI: f32 = 3.14159265359;
const NUM_WAVES: i32 = ${NUM_WAVES};
const SWELL_WAVE_COUNT: i32 = ${SWELL_WAVE_COUNT};
const GERSTNER_STEEPNESS: f32 = ${GERSTNER_STEEPNESS};
const GRAVITY: f32 = ${GRAVITY_FT_PER_S2};
const WAVE_AMP_MOD_SPATIAL_SCALE: f32 = ${WAVE_AMP_MOD_SPATIAL_SCALE};
const WAVE_AMP_MOD_TIME_SCALE: f32 = ${WAVE_AMP_MOD_TIME_SCALE};
const WAVE_AMP_MOD_STRENGTH: f32 = ${WAVE_AMP_MOD_STRENGTH};
const HEIGHT_SCALE: f32 = ${HEIGHT_SCALE};
const MAX_SEGMENTS: u32 = ${MAX_SEGMENTS}u;
const FLOATS_PER_SEGMENT: u32 = ${FLOATS_PER_SEGMENT}u;
const WATER_VELOCITY_FACTOR: f32 = ${WATER_VELOCITY_FACTOR};
const WATER_HEIGHT_NORM_SCALE: f32 = ${WATER_HEIGHT_SCALE};
const WATER_VELOCITY_NORM_SCALE: f32 = ${WATER_VELOCITY_SCALE};

// ============================================================================
// Uniforms and Bindings
// ============================================================================
struct Params {
  time: f32,
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  textureSizeX: f32,
  textureSizeY: f32,
  segmentCount: u32,
  // Terrain influence factors
  swellEnergyFactor: f32,  // 0-1, terrain diffraction effect on swell
  chopEnergyFactor: f32,   // 0-1, terrain shadow effect on chop
  fetchFactor: f32,        // 0-1, normalized fetch distance
  _padding: f32,           // Align to 16 bytes
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> waveData: array<f32>;
@group(0) @binding(2) var<storage, read> segments: array<f32>;
@group(0) @binding(3) var outputTexture: texture_storage_2d<rgba32float, write>;

// Simplex 3D Noise - for wave amplitude modulation
${SIMPLEX_NOISE_3D_WGSL}

// ============================================================================
// Hash function for white noise
// ============================================================================

fn hash2D(x: f32, y: f32) -> f32 {
  let n = sin(x * 127.1 + y * 311.7) * 43758.5453;
  return fract(n);
}

// ============================================================================
// Section 1: Gerstner Wave Calculation
// ============================================================================

fn calculateWaves(worldPos: vec2<f32>, time: f32) -> vec4<f32> {
  let x = worldPos.x;
  let y = worldPos.y;

  // Sample amplitude modulation noise once per point
  let ampModTime = time * WAVE_AMP_MOD_TIME_SCALE;
  let ampMod = 1.0 + simplex3D(vec3<f32>(
    x * WAVE_AMP_MOD_SPATIAL_SCALE,
    y * WAVE_AMP_MOD_SPATIAL_SCALE,
    ampModTime
  )) * WAVE_AMP_MOD_STRENGTH;

  // First pass: compute Gerstner horizontal displacement
  var dispX = 0.0;
  var dispY = 0.0;

  for (var i = 0; i < NUM_WAVES; i++) {
    let base = i * 8;
    let amplitude = waveData[base + 0];
    let wavelength = waveData[base + 1];
    let direction = waveData[base + 2];
    let phaseOffset = waveData[base + 3];
    let speedMult = waveData[base + 4];
    let sourceDist = waveData[base + 5];
    let sourceOffsetX = waveData[base + 6];
    let sourceOffsetY = waveData[base + 7];

    let baseDx = cos(direction);
    let baseDy = sin(direction);
    let k = (2.0 * PI) / wavelength;
    let omega = sqrt(GRAVITY * k) * speedMult;

    var dx: f32;
    var dy: f32;
    var phase: f32;

    if (sourceDist > 1e9) {
      dx = baseDx;
      dy = baseDy;
      let projected = x * dx + y * dy;
      phase = k * projected - omega * time + phaseOffset;
    } else {
      let sourceX = -baseDx * sourceDist + sourceOffsetX;
      let sourceY = -baseDy * sourceDist + sourceOffsetY;

      let toPointX = x - sourceX;
      let toPointY = y - sourceY;
      let distFromSource = sqrt(toPointX * toPointX + toPointY * toPointY);

      dx = toPointX / distFromSource;
      dy = toPointY / distFromSource;
      phase = k * distFromSource - omega * time + phaseOffset;
    }

    let Q = GERSTNER_STEEPNESS / (k * amplitude * f32(NUM_WAVES));
    let cosPhase = cos(phase);
    dispX += Q * amplitude * dx * cosPhase;
    dispY += Q * amplitude * dy * cosPhase;
  }

  // Second pass: compute height and dh/dt at displaced position
  let sampleX = x - dispX;
  let sampleY = y - dispY;
  var height = 0.0;
  var dhdt = 0.0;

  for (var i = 0; i < NUM_WAVES; i++) {
    let base = i * 8;
    var amplitude = waveData[base + 0];
    let wavelength = waveData[base + 1];
    let direction = waveData[base + 2];
    let phaseOffset = waveData[base + 3];
    let speedMult = waveData[base + 4];
    let sourceDist = waveData[base + 5];
    let sourceOffsetX = waveData[base + 6];
    let sourceOffsetY = waveData[base + 7];

    // Apply terrain influence based on wave type
    if (i < SWELL_WAVE_COUNT) {
      // Swell waves (0-4): apply swell energy factor
      amplitude *= params.swellEnergyFactor;
    } else {
      // Chop waves (5-11): apply chop energy factor * fetch factor
      amplitude *= params.chopEnergyFactor * params.fetchFactor;
    }

    let baseDx = cos(direction);
    let baseDy = sin(direction);
    let k = (2.0 * PI) / wavelength;
    let omega = sqrt(GRAVITY * k) * speedMult;

    var phase: f32;

    if (sourceDist > 1e9) {
      let projected = sampleX * baseDx + sampleY * baseDy;
      phase = k * projected - omega * time + phaseOffset;
    } else {
      let sourceX = -baseDx * sourceDist + sourceOffsetX;
      let sourceY = -baseDy * sourceDist + sourceOffsetY;

      let toPointX = sampleX - sourceX;
      let toPointY = sampleY - sourceY;
      let distFromSource = sqrt(toPointX * toPointX + toPointY * toPointY);

      phase = k * distFromSource - omega * time + phaseOffset;
    }

    let sinPhase = sin(phase);
    let cosPhase = cos(phase);

    height += amplitude * ampMod * sinPhase;
    dhdt += -amplitude * ampMod * omega * cosPhase;
  }

  // Add surface turbulence
  let smoothTurbulence =
    simplex3D(vec3<f32>(x * 0.15, y * 0.15, time * 0.5)) * 0.03 +
    simplex3D(vec3<f32>(x * 0.4, y * 0.4, time * 0.8)) * 0.01;

  let timeCell = floor(time * 0.5);
  let whiteTurbulence = (hash2D(x * 0.5 + timeCell, y * 0.5) - 0.5) * 0.02;

  height += smoothTurbulence + whiteTurbulence;

  return vec4<f32>(height, dispX, dispY, dhdt);
}

// ============================================================================
// Section 2: Wake Modifier Calculation
// ============================================================================

fn getSegmentContribution(worldX: f32, worldY: f32, segmentIndex: u32) -> vec3<f32> {
  let base = segmentIndex * FLOATS_PER_SEGMENT;

  let startX = segments[base + 0u];
  let startY = segments[base + 1u];
  let endX = segments[base + 2u];
  let endY = segments[base + 3u];
  let startRadius = segments[base + 4u];
  let endRadius = segments[base + 5u];
  let startIntensity = segments[base + 6u];
  let endIntensity = segments[base + 7u];
  let startVelX = segments[base + 8u];
  let startVelY = segments[base + 9u];
  let endVelX = segments[base + 10u];
  let endVelY = segments[base + 11u];

  let segX = endX - startX;
  let segY = endY - startY;
  let segLenSq = segX * segX + segY * segY;

  // Handle degenerate case (circle)
  if (segLenSq < 0.001) {
    let dx = worldX - startX;
    let dy = worldY - startY;
    let distSq = dx * dx + dy * dy;
    let radiusSq = startRadius * startRadius;

    if (distSq >= radiusSq) {
      return vec3<f32>(0.0, 0.0, 0.0);
    }

    let dist = sqrt(distSq);
    let t = dist / startRadius;
    let waveProfile = cos(t * PI) * (1.0 - t);
    let height = waveProfile * startIntensity * HEIGHT_SCALE;

    // Velocity: linear falloff from center
    let linearFalloff = 1.0 - t;
    let velFalloff = linearFalloff * startIntensity;
    let velX = startVelX * velFalloff * WATER_VELOCITY_FACTOR;
    let velY = startVelY * velFalloff * WATER_VELOCITY_FACTOR;

    return vec3<f32>(height, velX, velY);
  }

  // Segment contribution - project query point onto segment
  let toQueryX = worldX - startX;
  let toQueryY = worldY - startY;

  let t = clamp((toQueryX * segX + toQueryY * segY) / segLenSq, 0.0, 1.0);

  let closestX = startX + t * segX;
  let closestY = startY + t * segY;

  let perpDx = worldX - closestX;
  let perpDy = worldY - closestY;
  let perpDistSq = perpDx * perpDx + perpDy * perpDy;

  let radius = startRadius + t * (endRadius - startRadius);
  let radiusSq = radius * radius;

  if (perpDistSq >= radiusSq) {
    return vec3<f32>(0.0, 0.0, 0.0);
  }

  let perpDist = sqrt(perpDistSq);
  let normalizedDist = perpDist / radius;

  let intensity = startIntensity + t * (endIntensity - startIntensity);
  let waveProfile = cos(normalizedDist * PI) * (1.0 - normalizedDist);
  let height = waveProfile * intensity * HEIGHT_SCALE;

  // Interpolate velocity along segment
  let interpVelX = startVelX + t * (endVelX - startVelX);
  let interpVelY = startVelY + t * (endVelY - startVelY);

  // Velocity: linear falloff from ribbon center
  let linearFalloff = 1.0 - normalizedDist;
  let velFalloff = linearFalloff * intensity;
  let velX = interpVelX * velFalloff * WATER_VELOCITY_FACTOR;
  let velY = interpVelY * velFalloff * WATER_VELOCITY_FACTOR;

  return vec3<f32>(height, velX, velY);
}

fn calculateModifiers(worldX: f32, worldY: f32) -> vec3<f32> {
  var totalHeight: f32 = 0.0;
  var totalVelX: f32 = 0.0;
  var totalVelY: f32 = 0.0;

  let segCount = min(params.segmentCount, MAX_SEGMENTS);
  for (var i: u32 = 0u; i < segCount; i++) {
    let contrib = getSegmentContribution(worldX, worldY, i);
    totalHeight += contrib.x;
    totalVelX += contrib.y;
    totalVelY += contrib.z;
  }

  return vec3<f32>(totalHeight, totalVelX, totalVelY);
}

// ============================================================================
// Main: Combine wave and modifier calculations
// ============================================================================

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let texSize = vec2<f32>(params.textureSizeX, params.textureSizeY);

  if (f32(globalId.x) >= texSize.x || f32(globalId.y) >= texSize.y) {
    return;
  }

  // Convert texel to world position
  let uv = vec2<f32>(f32(globalId.x) + 0.5, f32(globalId.y) + 0.5) / texSize;
  let worldPos = vec2<f32>(
    params.viewportLeft + uv.x * params.viewportWidth,
    params.viewportTop + uv.y * params.viewportHeight
  );

  // Wave contribution
  let waveResult = calculateWaves(worldPos, params.time);
  let waveHeight = waveResult.x;
  let waveDhdt = waveResult.w;

  // Modifier contribution (wake effects) - returns (height, velX, velY)
  let modifierResult = calculateModifiers(worldPos.x, worldPos.y);
  let modifierHeight = modifierResult.x;
  let modifierVelX = modifierResult.y;
  let modifierVelY = modifierResult.z;

  // Combined output
  let totalHeight = waveHeight + modifierHeight;
  let normalizedHeight = totalHeight / WATER_HEIGHT_NORM_SCALE + 0.5;
  let normalizedDhdt = waveDhdt / WATER_VELOCITY_NORM_SCALE + 0.5;
  let normalizedVelX = modifierVelX / WATER_VELOCITY_NORM_SCALE + 0.5;
  let normalizedVelY = modifierVelY / WATER_VELOCITY_NORM_SCALE + 0.5;

  textureStore(outputTexture, vec2<i32>(globalId.xy), vec4<f32>(normalizedHeight, normalizedDhdt, normalizedVelX, normalizedVelY));
}
`;
}
