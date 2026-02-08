/**
 * Per-Wave Shadow Attenuation & Diffraction Shader Module
 *
 * Computes wave energy attenuation for a single wave source using:
 * - Point-in-polygon test for correct shadow region (follows actual coastline)
 * - Signed perpendicular distance to boundary rays for smooth Fresnel transition
 *
 * Also computes diffracted cylindrical wave contributions from silhouette edges,
 * implementing Huygens' principle for wave curving behind obstacles.
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";
import { fn_computeFresnelEnergy } from "./fresnel-diffraction.wgsl";
import {
  MAX_WAVE_SOURCES,
  MAX_SHADOW_POLYGONS,
} from "../../wave-physics/WavePhysicsManager";
import {
  struct_PolygonShadowData,
  fn_getShadowNumWaves,
  fn_getShadowWaveSetOffset,
  fn_getShadowWaveDirAt,
  fn_getShadowPolygonCountAt,
  fn_getShadowVerticesOffsetAt,
  fn_getShadowPolygon,
  fn_isInsideShadowPolygon,
} from "./shadow-packed.wgsl";
import { fn_computeWaveTerrainFactor } from "./wave-terrain.wgsl";

/**
 * Maximum wave source count constant, shared by shadow-attenuation and gerstner-wave modules.
 */
export const const_MAX_WAVE_SOURCES: ShaderModule = {
  code: /*wgsl*/ `
const MAX_WAVE_SOURCES: u32 = ${MAX_WAVE_SOURCES}u;
`,
};

/**
 * Computes shadow energy for a single wave at a world position.
 *
 * Uses point-in-polygon to correctly identify shadow regions (respects coastline shape),
 * then uses perpendicular distance to boundary rays with the polygon test providing the
 * sign. This gives a smooth Fresnel transition across the boundary with no hard line.
 *
 * Returns a single energy factor (0.0 = full shadow, 1.0 = full energy).
 */
export const fn_computeShadowEnergyForWave: ShaderModule = {
  dependencies: [
    const_MAX_WAVE_SOURCES,
    struct_PolygonShadowData,
    fn_computeFresnelEnergy,
    fn_getShadowNumWaves,
    fn_getShadowWaveSetOffset,
    fn_getShadowWaveDirAt,
    fn_getShadowPolygonCountAt,
    fn_getShadowVerticesOffsetAt,
    fn_getShadowPolygon,
    fn_isInsideShadowPolygon,
  ],
  code: /*wgsl*/ `
const MAX_SHADOW_POLYGONS: u32 = ${MAX_SHADOW_POLYGONS}u;

// Compute shadow attenuation for a single polygon using polygon test + signed distance
fn computePolygonAttenuationSingle(
  worldPos: vec2<f32>,
  polygon: PolygonShadowData,
  waveDir: vec2<f32>,
  wavelength: f32,
  insidePolygon: bool,
) -> f32 {
  let perpRight = vec2<f32>(waveDir.y, -waveDir.x);

  // Compute perpendicular distance to each shadow boundary ray.
  // Left boundary ray: extends from leftSilhouette along waveDir.
  //   Shadow is to the right of this ray (positive perpRight direction).
  // Right boundary ray: extends from rightSilhouette along waveDir.
  //   Shadow is to the left of this ray (negative perpRight direction).
  let perpDistLeft = dot(worldPos - polygon.leftSilhouette, perpRight);
  let perpDistRight = dot(worldPos - polygon.rightSilhouette, perpRight);

  // Distance to each boundary ray (unsigned)
  let distToLeft = abs(perpDistLeft);
  let distToRight = abs(perpDistRight);
  let distToBoundary = min(distToLeft, distToRight);

  // Sign the distance: negative inside shadow, positive outside
  var signedDist: f32;
  if (insidePolygon) {
    signedDist = -distToBoundary;
  } else {
    signedDist = distToBoundary;
  }

  // Distance behind obstacle along wave direction
  let distBehindLeft = dot(worldPos - polygon.leftSilhouette, waveDir);
  let distBehindRight = dot(worldPos - polygon.rightSilhouette, waveDir);
  let distBehind = max((distBehindLeft + distBehindRight) * 0.5, 0.0);

  // Compute Fresnel diffraction with signed distance
  let baseEnergy = computeFresnelEnergy(signedDist, distBehind, wavelength);

  // Shadow recovery: waves gradually return to full strength far behind obstacle
  let recoveryDist = polygon.obstacleWidth * polygon.obstacleWidth / wavelength;
  let recovery = smoothstep(0.5 * recoveryDist, recoveryDist, distBehind);

  return mix(baseEnergy, 1.0, recovery);
}

// Compute shadow energy for a specific wave source
fn computeShadowEnergyForWave(
  worldPos: vec2<f32>,
  packedShadow: ptr<storage, array<u32>, read>,
  waveIndex: u32,
  wavelength: f32,
) -> f32 {
  // Check if wave index is valid
  let numWaves = getShadowNumWaves(packedShadow);
  if (waveIndex >= numWaves) {
    return 1.0; // No shadow data for this wave
  }

  let setBase = getShadowWaveSetOffset(packedShadow, waveIndex);
  let waveDir = getShadowWaveDirAt(packedShadow, setBase);
  let polygonCount = min(getShadowPolygonCountAt(packedShadow, setBase), MAX_SHADOW_POLYGONS);
  let verticesOffset = getShadowVerticesOffsetAt(packedShadow, setBase);

  var energy = 1.0;

  for (var i: u32 = 0u; i < polygonCount; i = i + 1u) {
    let polygon = getShadowPolygon(packedShadow, setBase, i);

    // Early AABB rejection
    if (worldPos.x < polygon.bboxMin.x || worldPos.x > polygon.bboxMax.x ||
        worldPos.y < polygon.bboxMin.y || worldPos.y > polygon.bboxMax.y) {
      continue;
    }

    // Point-in-polygon determines shadow/lit ground truth
    let insidePolygon = isInsideShadowPolygon(worldPos, packedShadow, verticesOffset, polygon.vertexStartIndex, polygon.vertexCount);

    let polygonEnergy = computePolygonAttenuationSingle(worldPos, polygon, waveDir, wavelength, insidePolygon);
    energy = min(energy, polygonEnergy);
  }

  return energy;
}
`,
};

/**
 * Computes diffracted wave height contributions from shadow polygon silhouette edges.
 *
 * Each silhouette point acts as a cylindrical wave source (Huygens' principle).
 * The left silhouette diffracts into the shadow on its right side, and the right
 * silhouette diffracts into the shadow on its left side. This ensures waves curve
 * inward around the obstacle edges.
 *
 * Returns total diffracted height contribution (additive to the attenuated direct wave).
 */
export const fn_computeDiffractedWaves: ShaderModule = {
  dependencies: [
    const_MAX_WAVE_SOURCES,
    struct_PolygonShadowData,
    fn_getShadowNumWaves,
    fn_getShadowWaveSetOffset,
    fn_getShadowWaveDirAt,
    fn_getShadowPolygonCountAt,
    fn_getShadowPolygon,
    fn_computeWaveTerrainFactor,
  ],
  code: /*wgsl*/ `
// Diffraction coefficient: controls how much energy goes into curved waves
const DIFFRACTION_COEFF: f32 = 0.35;

// Minimum distance from silhouette point to avoid singularity
const MIN_DIFFRACTION_DIST: f32 = 2.0;

// Compute diffracted wave contribution from a single silhouette point.
// shadowPerpSign: +1.0 if shadow is in the +perpRight direction from this edge,
//                -1.0 if shadow is in the -perpRight direction.
fn computeSilhouetteDiffraction(
  worldPos: vec2<f32>,
  silhouettePoint: vec2<f32>,
  waveDir: vec2<f32>,
  perpRight: vec2<f32>,
  shadowPerpSign: f32,
  amplitude: f32,
  wavelength: f32,
  k: f32,
  omega: f32,
  time: f32,
  phaseOffset: f32,
) -> f32 {
  let toPoint = worldPos - silhouettePoint;
  let dist = length(toPoint);

  // Too close to the silhouette point - skip
  if (dist < MIN_DIFFRACTION_DIST) {
    return 0.0;
  }

  // Only contribute behind the obstacle (along wave direction)
  let behindDist = dot(toPoint, waveDir);
  if (behindDist < 0.0) {
    return 0.0;
  }

  // Only contribute on the shadow side of this edge.
  // For the left silhouette: shadow is to the right (perpDist > 0).
  // For the right silhouette: shadow is to the left (perpDist < 0).
  let perpDist = dot(toPoint, perpRight) * shadowPerpSign;
  if (perpDist < 0.0) {
    return 0.0;
  }

  // Angular falloff: strongest directly behind the edge, fading at wider angles.
  // Compute the angle of the point relative to the waveDir from the silhouette.
  let cosAngle = behindDist / dist;
  let angularWeight = cosAngle * cosAngle; // cos²(angle) falloff

  // Phase at the silhouette point from the incident plane wave
  let incidentPhase = k * dot(silhouettePoint, waveDir);

  // Total phase: incident phase at silhouette + radial propagation - omega*t
  let phase = incidentPhase + k * dist - omega * time + phaseOffset;

  // Cylindrical spreading: amplitude falls off as 1/sqrt(r)
  // Normalized by sqrt(wavelength / TWO_PI) to keep correct dimensions
  let spreading = sqrt(wavelength / (TWO_PI * dist));

  return amplitude * DIFFRACTION_COEFF * spreading * angularWeight * sin(phase);
}

// Compute total diffracted wave height from all shadow polygons for all wave sources
fn computeDiffractedWaves(
  worldPos: vec2<f32>,
  packedShadow: ptr<storage, array<u32>, read>,
  waveData: ptr<storage, array<f32>, read>,
  numWaves: u32,
  time: f32,
  ampMod: f32,
  depth: f32,
) -> f32 {
  let numShadowWaves = getShadowNumWaves(packedShadow);
  var totalDiffracted = 0.0;

  for (var w = 0u; w < numWaves; w++) {
    if (w >= numShadowWaves) {
      break;
    }

    // Read wave parameters
    let base = w * 8u;
    let amplitude = (*waveData)[base + 0u];
    let wavelength = (*waveData)[base + 1u];
    let phaseOffset = (*waveData)[base + 3u];
    let speedMult = (*waveData)[base + 4u];

    let k = TWO_PI / wavelength;
    let omega = sqrt(GRAVITY * k) * speedMult;

    // Terrain interaction for diffracted waves
    let terrainFactor = computeWaveTerrainFactor(depth, wavelength);
    if (terrainFactor < 0.001) {
      continue;
    }

    let setBase = getShadowWaveSetOffset(packedShadow, w);
    let waveDir = getShadowWaveDirAt(packedShadow, setBase);
    let perpRight = vec2<f32>(waveDir.y, -waveDir.x);
    let polygonCount = min(getShadowPolygonCountAt(packedShadow, setBase), MAX_SHADOW_POLYGONS);

    for (var i = 0u; i < polygonCount; i++) {
      let polygon = getShadowPolygon(packedShadow, setBase, i);

      // AABB early-out
      if (worldPos.x < polygon.bboxMin.x || worldPos.x > polygon.bboxMax.x ||
          worldPos.y < polygon.bboxMin.y || worldPos.y > polygon.bboxMax.y) {
        continue;
      }

      // Left silhouette diffracts INTO shadow (shadow is to its right: +perpRight)
      let leftContrib = computeSilhouetteDiffraction(
        worldPos, polygon.leftSilhouette, waveDir, perpRight, 1.0,
        amplitude, wavelength, k, omega, time, phaseOffset,
      );

      // Right silhouette diffracts INTO shadow (shadow is to its left: -perpRight)
      let rightContrib = computeSilhouetteDiffraction(
        worldPos, polygon.rightSilhouette, waveDir, perpRight, -1.0,
        amplitude, wavelength, k, omega, time, phaseOffset,
      );

      totalDiffracted += (leftContrib + rightContrib) * terrainFactor * ampMod;
    }
  }

  return totalDiffracted;
}
`,
};
