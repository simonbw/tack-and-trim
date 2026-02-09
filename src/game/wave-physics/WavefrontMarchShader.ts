/**
 * GPU compute shader for wavefront marching.
 *
 * Each dispatch advances one row of wavefront vertices by:
 * 1. Reading previous vertex position and march state
 * 2. Evaluating terrain height to compute water depth
 * 3. Computing refraction (direction bending toward shallower water)
 * 4. Computing depth-dependent wave speed for adaptive step size
 * 5. Advancing position along the (refracted) propagation direction
 * 6. Computing shoaling/damping amplitude factor
 * 7. Tracking convergence/divergence from neighbor spacing
 * 8. Accumulating phase offset for future rendering
 */

import type { ShaderModule } from "../../core/graphics/webgpu/ShaderModule";
import { ComputeShader } from "../../core/graphics/webgpu/ComputeShader";
import {
  defineUniformStruct,
  f32,
  u32,
} from "../../core/graphics/UniformStruct";
import {
  fn_getTerrainVertex,
  fn_getContourData,
  fn_getTerrainChild,
} from "../world/shaders/terrain-packed.wgsl";
import { fn_computeTerrainHeight } from "../world/shaders/terrain.wgsl";
import {
  fn_computeWaveSpeed,
  fn_computeRefractionOffset,
} from "../world/shaders/wave-physics.wgsl";
import { fn_computeWaveTerrainFactor } from "../world/shaders/wave-terrain.wgsl";

/** Uniform struct for march parameters */
export const MarchParams = defineUniformStruct("MarchParams", {
  prevStepOffset: u32,
  outStepOffset: u32,
  vertexCount: u32,
  stepIndex: u32,
  baseStepSize: f32,
  wavelength: f32,
  tideHeight: f32,
  k: f32,
  initialSpacing: f32,
  deepSpeed: f32,
  baseWaveDirX: f32,
  baseWaveDirY: f32,
  contourCount: u32,
  defaultDepth: f32,
  pingPong: u32,
  _pad: u32,
});

/** Number of floats per march state entry */
const STATE_FLOATS = 5;

/** March shader entry point module */
const marchEntryPoint: ShaderModule = {
  dependencies: [
    fn_getTerrainVertex,
    fn_getContourData,
    fn_getTerrainChild,
    fn_computeTerrainHeight,
    fn_computeWaveSpeed,
    fn_computeRefractionOffset,
    fn_computeWaveTerrainFactor,
  ],
  bindings: {
    params: { type: "uniform" as const, wgslType: "MarchParams" },
    meshVertices: { type: "storageRW" as const, wgslType: "array<f32>" },
    stateA: { type: "storageRW" as const, wgslType: "array<f32>" },
    stateB: { type: "storageRW" as const, wgslType: "array<f32>" },
    packedTerrain: { type: "storage" as const, wgslType: "array<u32>" },
  },
  preamble: MarchParams.wgsl,
  code: /*wgsl*/ `

// Read state from ping-pong buffer
fn readState(vi: u32) -> array<f32, ${STATE_FLOATS}> {
  var s: array<f32, ${STATE_FLOATS}>;
  let base = vi * ${STATE_FLOATS}u;
  if (params.pingPong == 0u) {
    for (var i = 0u; i < ${STATE_FLOATS}u; i++) {
      s[i] = stateA[base + i];
    }
  } else {
    for (var i = 0u; i < ${STATE_FLOATS}u; i++) {
      s[i] = stateB[base + i];
    }
  }
  return s;
}

// Write state to opposite ping-pong buffer
fn writeState(vi: u32, s: array<f32, ${STATE_FLOATS}>) {
  let base = vi * ${STATE_FLOATS}u;
  if (params.pingPong == 0u) {
    for (var i = 0u; i < ${STATE_FLOATS}u; i++) {
      stateB[base + i] = s[i];
    }
  } else {
    for (var i = 0u; i < ${STATE_FLOATS}u; i++) {
      stateA[base + i] = s[i];
    }
  }
}

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let vi = gid.x;
  if (vi >= params.vertexCount) {
    return;
  }

  // 1. Read previous vertex from meshVertices
  let prevBase = params.prevStepOffset + vi * 5u;
  let prevPosX = meshVertices[prevBase + 0u];
  let prevPosY = meshVertices[prevBase + 1u];

  // 2. Read state from previous step
  let prevState = readState(vi);
  let dirX = prevState[0];
  let dirY = prevState[1];
  let terminated = prevState[2];
  let accPhase = prevState[3];
  // prevState[4] = padding

  // Output base index
  let outBase = params.outStepOffset + vi * 5u;

  // 3. If terminated, copy vertex unchanged
  if (terminated > 0.5) {
    meshVertices[outBase + 0u] = prevPosX;
    meshVertices[outBase + 1u] = prevPosY;
    meshVertices[outBase + 2u] = 0.0; // amplitude = 0
    meshVertices[outBase + 3u] = 0.0;
    meshVertices[outBase + 4u] = 0.0;

    var outState: array<f32, ${STATE_FLOATS}>;
    outState[0] = dirX;
    outState[1] = dirY;
    outState[2] = 1.0; // still terminated
    outState[3] = accPhase;
    outState[4] = 0.0;
    writeState(vi, outState);
    return;
  }

  // 4. Evaluate terrain height at previous position
  let position = vec2<f32>(prevPosX, prevPosY);
  let terrainHeight = computeTerrainHeight(
    position,
    &packedTerrain,
    params.contourCount,
    params.defaultDepth
  );

  // 5. Compute depth
  let depth = params.tideHeight - terrainHeight;

  // 6. If on land, terminate
  if (depth <= 0.0) {
    meshVertices[outBase + 0u] = prevPosX;
    meshVertices[outBase + 1u] = prevPosY;
    meshVertices[outBase + 2u] = 0.0;
    meshVertices[outBase + 3u] = 0.0;
    meshVertices[outBase + 4u] = 0.0;

    var outState: array<f32, ${STATE_FLOATS}>;
    outState[0] = dirX;
    outState[1] = dirY;
    outState[2] = 1.0; // terminated
    outState[3] = accPhase;
    outState[4] = 0.0;
    writeState(vi, outState);
    return;
  }

  // 7. Depth gradient via finite differences
  let gradOffset = 5.0;
  let hRight = computeTerrainHeight(
    position + vec2<f32>(gradOffset, 0.0),
    &packedTerrain,
    params.contourCount,
    params.defaultDepth
  );
  let hUp = computeTerrainHeight(
    position + vec2<f32>(0.0, gradOffset),
    &packedTerrain,
    params.contourCount,
    params.defaultDepth
  );
  let depthRight = params.tideHeight - hRight;
  let depthUp = params.tideHeight - hUp;
  let depthGradient = vec2<f32>(
    (depthRight - depth) / gradOffset,
    (depthUp - depth) / gradOffset
  );

  // 8. Refraction
  let currentAngle = atan2(dirY, dirX);
  let refractionOffset = computeRefractionOffset(
    currentAngle,
    params.wavelength,
    depth,
    depthGradient
  );
  let newAngle = currentAngle + refractionOffset;
  let newDirX = cos(newAngle);
  let newDirY = sin(newAngle);

  // 9. Wave speed and adaptive step
  let speed = computeWaveSpeed(params.wavelength, depth);
  let stepDistance = params.baseStepSize * (speed / params.deepSpeed);

  // 10. Advance position
  let newPosX = prevPosX + newDirX * stepDistance;
  let newPosY = prevPosY + newDirY * stepDistance;

  // 11. Terrain factor (shoaling + damping)
  let terrainFactor = computeWaveTerrainFactor(depth, params.wavelength);

  // 12. Convergence/divergence from neighbor spacing
  var spacingRatio = 1.0;
  if (vi > 0u && vi < params.vertexCount - 1u) {
    // Read neighbor positions from previous step
    let leftBase = params.prevStepOffset + (vi - 1u) * 5u;
    let rightBase = params.prevStepOffset + (vi + 1u) * 5u;
    let leftX = meshVertices[leftBase + 0u];
    let leftY = meshVertices[leftBase + 1u];
    let rightX = meshVertices[rightBase + 0u];
    let rightY = meshVertices[rightBase + 1u];

    let currentSpacing = sqrt(
      (rightX - leftX) * (rightX - leftX) +
      (rightY - leftY) * (rightY - leftY)
    ) * 0.5;

    // Ratio of initial spacing to current spacing
    // > 1 = convergence (amplitude increases)
    // < 1 = divergence (amplitude decreases)
    let safeSpacing = max(currentSpacing, params.initialSpacing * 0.01);
    spacingRatio = sqrt(params.initialSpacing / safeSpacing);
    spacingRatio = clamp(spacingRatio, 0.1, 3.0);
  }

  let amplitudeFactor = terrainFactor * spacingRatio;

  // 13. Phase tracking
  let newAccPhase = accPhase + params.k * stepDistance;
  let basePhaseAtNewPos = (newPosX * params.baseWaveDirX + newPosY * params.baseWaveDirY) * params.k;
  let phaseOffset = newAccPhase - basePhaseAtNewPos;

  // Direction offset from base
  let dirOffset = newAngle - atan2(params.baseWaveDirY, params.baseWaveDirX);

  // 14. Write output vertex
  meshVertices[outBase + 0u] = newPosX;
  meshVertices[outBase + 1u] = newPosY;
  meshVertices[outBase + 2u] = amplitudeFactor;
  meshVertices[outBase + 3u] = dirOffset;
  meshVertices[outBase + 4u] = phaseOffset;

  // Write output state
  var outState: array<f32, ${STATE_FLOATS}>;
  outState[0] = newDirX;
  outState[1] = newDirY;
  outState[2] = 0.0; // not terminated
  outState[3] = newAccPhase;
  outState[4] = 0.0;
  writeState(vi, outState);
}
`,
};

/** Create the wavefront march compute shader */
export function createWavefrontMarchShader(): ComputeShader {
  return new ComputeShader({
    modules: [marchEntryPoint],
    workgroupSize: [64, 1],
    label: "Wavefront March",
  });
}
