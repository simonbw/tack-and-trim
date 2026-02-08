/**
 * Per-Wave Shadow Attenuation Shader Module
 *
 * Computes wave energy attenuation for a single wave source by looping
 * through that wave's shadow polygon set and applying Fresnel diffraction.
 * Each wave source has its own polygon set with its own direction.
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
 * Computes shadow energy for a single wave at a world position.
 *
 * Reads the wave's polygon set from the packed shadow buffer,
 * loops through polygons with AABB reject + point-in-polygon test,
 * and computes Fresnel diffraction using the wave's actual wavelength.
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

// Compute shadow attenuation for a single polygon at a given wavelength
fn computePolygonAttenuationSingle(
  worldPos: vec2<f32>,
  polygon: PolygonShadowData,
  waveDir: vec2<f32>,
  wavelength: f32,
) -> f32 {
  let perpRight = vec2<f32>(waveDir.y, -waveDir.x);

  // Compute distances to both shadow boundaries
  let toLeft = worldPos - polygon.leftSilhouette;
  let toRight = worldPos - polygon.rightSilhouette;

  let distToLeft = abs(dot(toLeft, perpRight));
  let distToRight = abs(dot(toRight, perpRight));
  let distBehindLeft = dot(toLeft, waveDir);
  let distBehindRight = dot(toRight, waveDir);

  // Use closer boundary for diffraction calculation
  let distToBoundary = min(distToLeft, distToRight);
  let distBehind = max((distBehindLeft + distBehindRight) * 0.5, 0.0);

  // Compute Fresnel diffraction for this wavelength
  let baseEnergy = computeFresnelEnergy(distToBoundary, distBehind, wavelength);

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

    // Check if point is inside this shadow polygon
    if (isInsideShadowPolygon(worldPos, packedShadow, verticesOffset, polygon.vertexStartIndex, polygon.vertexCount)) {
      let polygonEnergy = computePolygonAttenuationSingle(worldPos, polygon, waveDir, wavelength);
      energy = min(energy, polygonEnergy);
    }
  }

  return energy;
}
`,
};
