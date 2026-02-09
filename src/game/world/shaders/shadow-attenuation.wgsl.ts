/**
 * Per-Wave Shadow Attenuation & Direction Bending Shader Module
 *
 * Computes wave energy attenuation and direction bending for a single wave source using:
 * - Point-in-polygon test for correct shadow region (follows actual coastline)
 * - Signed perpendicular distance to boundary rays for smooth Fresnel transition
 * - Direction offset from silhouette geometry to bend waves around obstacles
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

/**
 * Maximum wave source count constant, shared by shadow-attenuation and gerstner-wave modules.
 */
export const const_MAX_WAVE_SOURCES: ShaderModule = {
  code: /*wgsl*/ `
const MAX_WAVE_SOURCES: u32 = ${MAX_WAVE_SOURCES}u;
`,
};

/**
 * Computes shadow energy and direction offset for a single wave at a world position.
 *
 * Uses point-in-polygon to correctly identify shadow regions (respects coastline shape),
 * then uses perpendicular distance to boundary rays with the polygon test providing the
 * sign. This gives a smooth Fresnel transition across the boundary with no hard line.
 *
 * Direction offset bends wave propagation toward shadow zone edges, creating visible
 * wave curving around obstacles (diffraction effect).
 *
 * Returns ShadowResult with energy factor and direction offset in radians.
 */
export const fn_computeShadowForWave: ShaderModule = {
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
const QUARTER_PI: f32 = 0.7853981633974483;

struct ShadowResult {
  energy: f32,
  directionOffset: f32,
}

struct PolygonShadowResult {
  energy: f32,
  directionOffset: f32,
}

// Compute shadow attenuation and direction offset for a single polygon
fn computePolygonAttenuationSingle(
  worldPos: vec2<f32>,
  polygon: PolygonShadowData,
  waveDir: vec2<f32>,
  wavelength: f32,
  insidePolygon: bool,
) -> PolygonShadowResult {
  let perpRight = vec2<f32>(waveDir.y, -waveDir.x);

  // Compute perpendicular distance to each shadow boundary ray.
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

  let energy = mix(baseEnergy, 1.0, recovery);

  // Compute direction offset from silhouette geometry
  let toLeft = worldPos - polygon.leftSilhouette;
  let toRight = worldPos - polygon.rightSilhouette;
  let toLeftLen = length(toLeft);
  let toRightLen = length(toRight);

  var dirOffset = 0.0;
  if (toLeftLen > 0.1 && toRightLen > 0.1) {
    let toLeftDir = toLeft / toLeftLen;
    let toRightDir = toRight / toRightLen;

    // Angle between waveDir and direction to each silhouette point
    let angleLeft = atan2(
      waveDir.x * toLeftDir.y - waveDir.y * toLeftDir.x,
      dot(waveDir, toLeftDir),
    );
    let angleRight = atan2(
      waveDir.x * toRightDir.y - waveDir.y * toRightDir.x,
      dot(waveDir, toRightDir),
    );

    // Blend: closer to right boundary → more left-edge bending, and vice versa
    let totalDist = distToLeft + distToRight;
    if (totalDist > 0.01) {
      let w = distToRight / totalDist; // 1.0 near left edge, 0.0 near right
      let blendedAngle = angleLeft * w + angleRight * (1.0 - w);
      dirOffset = clamp(blendedAngle * (1.0 - energy), -QUARTER_PI, QUARTER_PI);
    }
  }

  return PolygonShadowResult(energy, dirOffset);
}

// Compute shadow result for a specific wave source
fn computeShadowForWave(
  worldPos: vec2<f32>,
  packedShadow: ptr<storage, array<u32>, read>,
  waveIndex: u32,
  wavelength: f32,
) -> ShadowResult {
  // Check if wave index is valid
  let numWaves = getShadowNumWaves(packedShadow);
  if (waveIndex >= numWaves) {
    return ShadowResult(1.0, 0.0);
  }

  let setBase = getShadowWaveSetOffset(packedShadow, waveIndex);
  let waveDir = getShadowWaveDirAt(packedShadow, setBase);
  let polygonCount = min(getShadowPolygonCountAt(packedShadow, setBase), MAX_SHADOW_POLYGONS);
  let verticesOffset = getShadowVerticesOffsetAt(packedShadow, setBase);

  var energy = 1.0;
  var dirOffset = 0.0;

  for (var i: u32 = 0u; i < polygonCount; i = i + 1u) {
    let polygon = getShadowPolygon(packedShadow, setBase, i);

    // Early AABB rejection
    if (worldPos.x < polygon.bboxMin.x || worldPos.x > polygon.bboxMax.x ||
        worldPos.y < polygon.bboxMin.y || worldPos.y > polygon.bboxMax.y) {
      continue;
    }

    // Point-in-polygon determines shadow/lit ground truth
    let insidePolygon = isInsideShadowPolygon(worldPos, packedShadow, verticesOffset, polygon.vertexStartIndex, polygon.vertexCount);

    let result = computePolygonAttenuationSingle(worldPos, polygon, waveDir, wavelength, insidePolygon);

    // Use the offset from the polygon with the lowest energy (most shadowing)
    if (result.energy < energy) {
      energy = result.energy;
      dirOffset = result.directionOffset;
    }
  }

  return ShadowResult(energy, dirOffset);
}
`,
};
