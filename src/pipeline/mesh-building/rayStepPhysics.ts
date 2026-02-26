import type { TerrainCPUData } from "../../game/world/terrain/TerrainCPUData";
import type { MeshBuildPhysicsConfig } from "./meshBuildConfig";
import {
  computeTerrainHeightAndGradient,
  type TerrainHeightGradient,
} from "./terrainHeightCPU";

/** Normalized wave speed (c/c_deep) from water depth. Returns 0 for dry land. */
function normalizedSpeed(depth: number, k: number): number {
  if (depth <= 0) return 0;
  return Math.sqrt(Math.tanh(k * depth));
}

export function advanceSentinelRay(
  px: number,
  py: number,
  waveDx: number,
  waveDy: number,
  stepSize: number,
  minProj: number,
  maxProj: number,
): { nx: number; ny: number } | null {
  const nx = px + waveDx * stepSize;
  const ny = py + waveDy * stepSize;

  // OOB check on downwave edge only (sentinels are at lateral boundary by definition)
  const proj = nx * waveDx + ny * waveDy;
  if (proj < minProj || proj > maxProj) {
    return null;
  }

  return { nx, ny };
}

export interface AdvanceInteriorRayInput {
  px: number;
  py: number;
  startEnergy: number;
  prevTurbulence: number;
  baseDirX: number;
  baseDirY: number;
  waveDx: number;
  waveDy: number;
  perpDx: number;
  perpDy: number;
  minProj: number;
  maxProj: number;
  minPerp: number;
  maxPerp: number;
  stepSize: number;
  wavelength: number;
  k: number;
  breakingDepth: number;
  physics: MeshBuildPhysicsConfig;
  terrain: TerrainCPUData;
  terrainGradientSample: TerrainHeightGradient;
  currentDepth: number;
  currentGradientX: number;
  currentGradientY: number;
}

export interface AdvanceInteriorRayResult {
  nx: number;
  ny: number;
  dirX: number;
  dirY: number;
  energy: number;
  turbulence: number;
  depth: number;
  terrainGradX: number;
  terrainGradY: number;
  refracted: boolean;
  turnClamped: boolean;
}

export function advanceInteriorRay(
  input: AdvanceInteriorRayInput,
): AdvanceInteriorRayResult | null {
  let currentDepth = input.currentDepth;
  let gradX = input.currentGradientX;
  let gradY = input.currentGradientY;
  if (
    !Number.isFinite(currentDepth) ||
    !Number.isFinite(gradX) ||
    !Number.isFinite(gradY)
  ) {
    const terrainH = computeTerrainHeightAndGradient(
      input.px,
      input.py,
      input.terrain,
      input.terrainGradientSample,
    ).height;
    currentDepth = Math.max(0, -terrainH);
    gradX = input.terrainGradientSample.gradientX;
    gradY = input.terrainGradientSample.gradientY;
  }
  const baseSpeed = normalizedSpeed(currentDepth, input.k);
  const currentSpeed = Math.max(input.physics.minSpeedFactor, baseSpeed);
  const localStep = input.stepSize * currentSpeed;

  let dirX = input.baseDirX;
  let dirY = input.baseDirY;
  let absDTheta = 0;
  let refracted = false;
  let turnClamped = false;

  // Apply Snell's law refraction when underwater.
  // On terrain, skip — there's no meaningful depth gradient to refract from.
  if (currentDepth > 0) {
    // c(depth) = sqrt(tanh(k*depth)), depth = -height.
    // dc/dx = (dc/ddepth) * ddepth/dx = -(dc/ddepth) * dheight/dx
    const tanhKd = baseSpeed * baseSpeed;
    const sech2Kd = 1 - tanhKd * tanhKd;
    const dcDDepth = baseSpeed > 1e-6 ? (input.k * sech2Kd) / (2 * baseSpeed) : 0;
    const dcdx = -dcDDepth * gradX;
    const dcdy = -dcDDepth * gradY;

    // Component of speed gradient perpendicular to ray direction
    const dcPerp = -dcdx * dirY + dcdy * dirX;

    // Snell's law: dθ = -(1/c) * ∂c/∂n * ds
    const rawDTheta = -(1 / currentSpeed) * dcPerp * localStep;
    const dTheta = Math.max(
      -input.physics.maxTurnPerStepRad,
      Math.min(input.physics.maxTurnPerStepRad, rawDTheta),
    );
    absDTheta = Math.abs(dTheta);
    refracted = true;
    if (Math.abs(rawDTheta) > input.physics.maxTurnPerStepRad) {
      turnClamped = true;
    }

    const cosD = Math.cos(dTheta);
    const sinD = Math.sin(dTheta);
    dirX = input.baseDirX * cosD - input.baseDirY * sinD;
    dirY = input.baseDirX * sinD + input.baseDirY * cosD;
  }

  // Advance along ray direction
  const nx = input.px + dirX * localStep;
  const ny = input.py + dirY * localStep;

  // Bounds check in wave-aligned coordinates
  const proj = nx * input.waveDx + ny * input.waveDy;
  const perp = nx * input.perpDx + ny * input.perpDy;
  if (
    proj < input.minProj ||
    proj > input.maxProj ||
    perp < input.minPerp ||
    perp > input.maxPerp
  ) {
    return null;
  }

  // Update energy (dissipative losses only)
  const newTerrainH = computeTerrainHeightAndGradient(
    nx,
    ny,
    input.terrain,
    input.terrainGradientSample,
  ).height;
  const newDepth = -newTerrainH;
  const normalizedStep = localStep / input.wavelength;

  let energy = input.startEnergy;

  // Refraction dissipation: sharp direction changes lose energy.
  if (absDTheta > 0) {
    energy *= Math.exp(-input.physics.refractionDissipation * absDTheta);
  }

  // Bottom friction + breaking: unified energy dissipation.
  // Skip at max ocean depth — open ocean floor has no seabed interaction.
  const energyBeforeDissipation = energy;
  if (newDepth < input.wavelength) {
    const frictionDecay =
      input.physics.bottomFrictionRate *
      Math.exp(-input.k * newDepth) *
      normalizedStep;
    energy *= Math.exp(-frictionDecay);

    // Breaking: additional strong decay in very shallow water
    if (newDepth < input.breakingDepth) {
      energy *= Math.exp(-input.physics.breakingDecayRate * normalizedStep);
    }
  }

  // Carry forward previous step's turbulence with phase-based decay,
  // then add new local dissipation
  const carryOver =
    input.prevTurbulence *
    Math.exp(-input.physics.turbulenceDecayRate * normalizedStep);
  const localTurbulence =
    (energyBeforeDissipation - energy) * input.physics.turbulenceScale;
  const turbulence = carryOver + localTurbulence;

  return {
    nx,
    ny,
    dirX,
    dirY,
    energy,
    turbulence,
    depth: Math.max(0, newDepth),
    terrainGradX: input.terrainGradientSample.gradientX,
    terrainGradY: input.terrainGradientSample.gradientY,
    refracted,
    turnClamped,
  };
}
