/**
 * Analytical Shadow Attenuation Shader Module
 *
 * Computes wave energy attenuation by looping through shadow polygons
 * and applying Fresnel diffraction. Uses proper point-in-polygon testing
 * with the winding number algorithm for accurate shadow region detection.
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";
import { fn_computeFresnelEnergy } from "./fresnel-diffraction.wgsl";
import { MAX_SHADOW_POLYGONS } from "../../wave-physics/WavePhysicsManager";
import {
  struct_PolygonShadowData,
  fn_getShadowWaveDirection,
  fn_getShadowPolygonCount,
  fn_getShadowPolygon,
  fn_isInsideShadowPolygon,
} from "./shadow-packed.wgsl";

// Wavelength constants for swell and chop waves
const SWELL_WAVELENGTH = 200.0; // feet
const CHOP_WAVELENGTH = 30.0; // feet

/**
 * Result of shadow attenuation computation.
 */
export const struct_ShadowAttenuation: ShaderModule = {
  preamble: /*wgsl*/ `
// Shadow attenuation result for swell and chop waves
struct ShadowAttenuation {
  swellEnergy: f32,  // 0.0 = full shadow, 1.0 = full energy
  chopEnergy: f32,
}
`,
  code: "",
};

/**
 * Computes analytical shadow attenuation at a world position.
 *
 * Loops through all shadow polygons and computes Fresnel diffraction
 * for each one that affects this point. Uses winding number algorithm
 * for accurate point-in-polygon testing. Takes the minimum energy
 * (maximum shadow) across all polygons.
 */
export const fn_computeShadowAttenuation: ShaderModule = {
  dependencies: [
    struct_PolygonShadowData,
    struct_ShadowAttenuation,
    fn_computeFresnelEnergy,
    fn_getShadowWaveDirection,
    fn_getShadowPolygonCount,
    fn_getShadowPolygon,
    fn_isInsideShadowPolygon,
  ],
  code: /*wgsl*/ `
const MAX_SHADOW_POLYGONS: u32 = ${MAX_SHADOW_POLYGONS}u;
const SWELL_WAVELENGTH: f32 = ${SWELL_WAVELENGTH};
const CHOP_WAVELENGTH: f32 = ${CHOP_WAVELENGTH};

// Compute shadow attenuation for a single polygon
fn computePolygonAttenuation(
  worldPos: vec2<f32>,
  polygon: PolygonShadowData,
  waveDir: vec2<f32>,
) -> ShadowAttenuation {
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

  // Compute Fresnel diffraction for both wavelength classes
  let swellBase = computeFresnelEnergy(distToBoundary, distBehind, SWELL_WAVELENGTH);
  let chopBase = computeFresnelEnergy(distToBoundary, distBehind, CHOP_WAVELENGTH);

  // Shadow recovery: waves gradually return to full strength far behind obstacle
  let swellRecoveryDist = polygon.obstacleWidth * polygon.obstacleWidth / SWELL_WAVELENGTH;
  let chopRecoveryDist = polygon.obstacleWidth * polygon.obstacleWidth / CHOP_WAVELENGTH;

  let swellRecovery = smoothstep(0.5 * swellRecoveryDist, swellRecoveryDist, distBehind);
  let chopRecovery = smoothstep(0.5 * chopRecoveryDist, chopRecoveryDist, distBehind);

  // Mix toward full energy at recovery distance
  var result: ShadowAttenuation;
  result.swellEnergy = mix(swellBase, 1.0, swellRecovery);
  result.chopEnergy = mix(chopBase, 1.0, chopRecovery);
  return result;
}

// Compute combined shadow attenuation from all polygons
fn computeShadowAttenuation(
  worldPos: vec2<f32>,
  packedShadow: ptr<storage, array<u32>, read>,
) -> ShadowAttenuation {
  var result: ShadowAttenuation;
  result.swellEnergy = 1.0;
  result.chopEnergy = 1.0;

  let waveDir = getShadowWaveDirection(packedShadow);
  let polygonCount = min(getShadowPolygonCount(packedShadow), MAX_SHADOW_POLYGONS);

  // Loop through all shadow polygons
  for (var i: u32 = 0u; i < polygonCount; i = i + 1u) {
    let polygon = getShadowPolygon(packedShadow, i);

    // Early AABB rejection
    if (worldPos.x < polygon.bboxMin.x || worldPos.x > polygon.bboxMax.x ||
        worldPos.y < polygon.bboxMin.y || worldPos.y > polygon.bboxMax.y) {
      continue;
    }

    // Check if point is inside this shadow polygon using winding number algorithm
    if (isInsideShadowPolygon(worldPos, packedShadow, polygon.vertexStartIndex, polygon.vertexCount)) {
      // Compute attenuation for this polygon
      let polygonAtten = computePolygonAttenuation(worldPos, polygon, waveDir);

      // Take minimum energy (maximum shadow effect)
      result.swellEnergy = min(result.swellEnergy, polygonAtten.swellEnergy);
      result.chopEnergy = min(result.chopEnergy, polygonAtten.chopEnergy);
    }
  }

  return result;
}
`,
};
