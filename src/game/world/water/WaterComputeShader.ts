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
  /** Terrain heights for depth calculation (f32 array, same length as queryPoints) */
  terrainHeights: { type: "storage" },
  /** Shadow textures (one per wave source, rg8unorm) */
  shadowTextures: { type: "texture", viewDimension: "2d-array" },
  /** Shadow texture sampler (linear filtering) */
  shadowSampler: { type: "sampler" },
  /** Water modifiers (8 floats per modifier) */
  modifiers: { type: "storage" },
  /** Modifier parameters (modifierCount) */
  modifierParams: { type: "uniform" },
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

// ============================================================================
// Structs and Bindings
// ============================================================================

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

struct WaterModifier {
  modifierType: f32,  // 1=wake, 2=current, 3=obstacle
  boundsMinX: f32,
  boundsMinY: f32,
  boundsMaxX: f32,
  boundsMaxY: f32,
  param0: f32,        // Type-specific param 0
  param1: f32,        // Type-specific param 1
  param2: f32,        // Type-specific param 2
}

struct ModifierParams {
  modifierCount: u32,
  _padding: vec3u,
}

@group(0) @binding(0) var<storage, read> queryPoints: array<vec2f>;
@group(0) @binding(1) var<storage, read_write> results: array<f32>;
@group(0) @binding(2) var<storage, read> waveSources: array<WaveSource>;
@group(0) @binding(3) var<uniform> waterParams: WaterParams;
@group(0) @binding(4) var<storage, read> terrainHeights: array<f32>;
@group(0) @binding(5) var shadowTextures: texture_2d_array<f32>;
@group(0) @binding(6) var shadowSampler: sampler;
@group(0) @binding(7) var<storage, read> modifiers: array<WaterModifier>;
@group(0) @binding(8) var<uniform> modifierParams: ModifierParams;

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Compute depth-based wave modifier (shoaling + damping).
 *
 * Shoaling: Waves amplify in shallow water (Green's Law: (refDepth / depth)^0.25)
 * Damping: Waves dampen very near shore (linear fade)
 */
fn computeDepthModifier(depth: f32, k: f32) -> f32 {
  // Clamp depth to avoid division by zero
  let safeDepth = max(depth, 0.1);

  // Reference depth for deep water (100m)
  let refDepth = 100.0;

  // Shoaling effect (Green's Law)
  let shoaling = pow(refDepth / safeDepth, 0.25);

  // Damping in very shallow water (< 2m)
  let dampingThreshold = 2.0;
  let damping = select(1.0, safeDepth / dampingThreshold, safeDepth < dampingThreshold);

  return shoaling * damping;
}

/**
 * Sample shadow texture for a wave at a world position.
 *
 * Returns shadow intensity (0 = light, 1 = shadowed)
 */
fn sampleShadow(worldPos: vec2f, waveIndex: u32, tileSize: f32) -> f32 {
  // Convert world position to tile coordinates (LOD 0)
  let tileCoord = worldPos / tileSize;

  // Sample shadow texture array (rg8unorm format)
  // R channel = shadow intensity, G channel = distance to edge
  let shadowSample = textureSampleLevel(
    shadowTextures,
    shadowSampler,
    fract(tileCoord),  // UV coordinates (wrap)
    i32(waveIndex),    // Layer index
    0.0                // LOD level
  );

  return shadowSample.r;  // Shadow intensity
}

/**
 * Evaluate modifier contribution at a position.
 *
 * Returns height contribution from the modifier.
 */
fn evaluateModifier(modifier: WaterModifier, pos: vec2f, time: f32) -> f32 {
  // Bounds culling
  if (pos.x < modifier.boundsMinX || pos.x > modifier.boundsMaxX ||
      pos.y < modifier.boundsMinY || pos.y > modifier.boundsMaxY) {
    return 0.0;
  }

  let modType = u32(modifier.modifierType);

  // Wake modifier: radial ripple
  if (modType == 1u) {
    let center = vec2f((modifier.boundsMinX + modifier.boundsMaxX) * 0.5,
                       (modifier.boundsMinY + modifier.boundsMaxY) * 0.5);
    let strength = modifier.param0;
    let direction = modifier.param1;

    let dist = length(pos - center);
    let maxRadius = (modifier.boundsMaxX - modifier.boundsMinX) * 0.5;

    // Radial wave with falloff
    let radialPhase = dist * 0.5 - time * 2.0;
    let falloff = 1.0 - smoothstep(0.0, maxRadius, dist);
    return strength * sin(radialPhase) * falloff;
  }

  // Current modifier: adds velocity (affects velocity field, not height directly)
  // For MVP, currents don't affect height
  if (modType == 2u) {
    return 0.0;
  }

  // Obstacle modifier: dampens waves
  // Represented as negative height contribution
  if (modType == 3u) {
    let dampingFactor = modifier.param0;
    let center = vec2f((modifier.boundsMinX + modifier.boundsMaxX) * 0.5,
                       (modifier.boundsMinY + modifier.boundsMaxY) * 0.5);
    let dist = length(pos - center);
    let maxRadius = (modifier.boundsMaxX - modifier.boundsMinX) * 0.5;
    let falloff = 1.0 - smoothstep(0.0, maxRadius, dist);

    // Damping reduces wave height (represented as negative contribution)
    return -dampingFactor * falloff * 0.1;  // Small negative offset
  }

  return 0.0;
}

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
 *   [1-2]: velocity (m/s, x and y) [stub]
 *   [3-4]: normal (unit vector, x and y pointing "upslope")
 *   [5]: depth (m) [now populated]
 */
@compute @workgroup_size(64, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let pointIndex = id.x;
  if (pointIndex >= arrayLength(&queryPoints)) {
    return;
  }

  let point = queryPoints[pointIndex];
  let time = waterParams.time;

  // Get terrain depth (negative terrain height = positive depth)
  let terrainHeight = terrainHeights[pointIndex];
  let depth = max(0.0, -terrainHeight);

  // PASS 1: Accumulate horizontal displacement from all waves
  let waveCount = u32(waterParams.waveCount);
  var displacement = vec2f(0.0);
  for (var i = 0u; i < waveCount; i++) {
    displacement += gerstnerDisplacement(waveSources[i], point, time);
  }

  let displacedPos = point + displacement;

  // PASS 2: Evaluate waves with shadow and depth effects
  var totalZ = 0.0;
  var totalVz = 0.0;
  let tileSize = 128.0; // Match VirtualTexture tile size

  for (var i = 0u; i < waveCount; i++) {
    let wave = waveSources[i];

    // Sample shadow for this wave
    let shadowIntensity = sampleShadow(displacedPos, i, tileSize);

    // Compute depth modifier (shoaling + damping)
    let depthModifier = computeDepthModifier(depth, wave.k);

    // Evaluate wave
    let result = evaluateWave(wave, displacedPos, time);

    // Apply shadow attenuation (0 = full shadow, 1 = no shadow)
    let shadowAttenuation = 1.0 - shadowIntensity;

    // Apply depth modifier and shadow
    let waveContribution = result.x * depthModifier * shadowAttenuation;

    totalZ += waveContribution;
    totalVz += result.y * depthModifier * shadowAttenuation;
  }

  // PASS 3: Apply water modifiers
  let modCount = modifierParams.modifierCount;
  var modifierHeight = 0.0;

  for (var i = 0u; i < modCount; i++) {
    modifierHeight += evaluateModifier(modifiers[i], displacedPos, time);
  }

  totalZ += modifierHeight;

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
  results[offset + 1u] = 0.0;           // velocityX (stub)
  results[offset + 2u] = 0.0;           // velocityY (stub)
  results[offset + 3u] = normal.x;      // normalX
  results[offset + 4u] = normal.y;      // normalY
  results[offset + 5u] = depth;         // depth (now populated)
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
