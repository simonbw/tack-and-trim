import { clamp, degToRad } from "../../../core/util/MathUtil";
import { RHO_AIR } from "../../physics-constants";
import type { ClothSolver } from "./ClothSolver";

// The physics engine uses mass in "lbs" but F=ma with gravity=32.174 ft/s²,
// meaning it effectively treats mass as slugs. Aerodynamic formulas with
// RHO_AIR in slugs/ft³ produce force in lbf, so we multiply by g to convert
// lbf to the engine's force units (slug·ft/s²).
const LBF_TO_ENGINE = 32.174;

export const STALL_ANGLE = degToRad(15);

/** Calculate the lift coefficient for a sail at a given angle of attack. */
function getSailLiftCoefficient(angleOfAttack: number): number {
  const alpha = Math.abs(angleOfAttack);
  const effectiveAlpha = alpha > Math.PI / 2 ? Math.PI - alpha : alpha;

  let cl: number;
  if (effectiveAlpha < STALL_ANGLE) {
    cl = 2 * Math.PI * Math.sin(effectiveAlpha);
  } else {
    const peak = 2 * Math.PI * Math.sin(STALL_ANGLE);
    const decay = Math.exp(-3 * (effectiveAlpha - STALL_ANGLE));
    cl = peak * decay;
  }

  cl *= Math.sign(Math.cos(angleOfAttack));
  return cl;
}

/**
 * Compute drag coefficient for a sail segment.
 * Base drag + induced drag + stall penalty.
 */
function computeDragCoefficient(aoa: number): number {
  const effectiveAlpha = aoa > Math.PI / 2 ? Math.PI - aoa : aoa;

  const baseDrag = 0.02;
  const inducedDrag = 0.1 * effectiveAlpha * effectiveAlpha;
  const stallDrag =
    effectiveAlpha > STALL_ANGLE ? 0.5 * (effectiveAlpha - STALL_ANGLE) : 0;

  return baseDrag + inducedDrag + stallDrag;
}

/**
 * Compute per-triangle wind force for cloth sail simulation.
 * Returns [fx, fy, fz] force to be distributed 1/3 to each vertex.
 *
 * Uses the relative wind (true wind minus surface velocity) so that
 * aerodynamic force naturally decays as the cloth catches up to the
 * wind. This provides physical damping that prevents runaway oscillation.
 *
 * @param solver - ClothSolver with vertex positions
 * @param i0 - First vertex index
 * @param i1 - Second vertex index
 * @param i2 - Third vertex index
 * @param windX - Apparent wind X (world space)
 * @param windY - Apparent wind Y (world space)
 * @param liftScale - Lift coefficient multiplier
 * @param dragScale - Drag coefficient multiplier
 * @param tickRate - Physics tick rate (Hz) for velocity estimation from Verlet positions
 */
export function computeClothWindForce(
  solver: ClothSolver,
  i0: number,
  i1: number,
  i2: number,
  windX: number,
  windY: number,
  liftScale: number,
  dragScale: number,
  tickRate: number = 120,
): [number, number, number] {
  // Get vertex positions
  const x0 = solver.getPositionX(i0);
  const y0 = solver.getPositionY(i0);
  const z0 = solver.getZ(i0);
  const x1 = solver.getPositionX(i1);
  const y1 = solver.getPositionY(i1);
  const z1 = solver.getZ(i1);
  const x2 = solver.getPositionX(i2);
  const y2 = solver.getPositionY(i2);
  const z2 = solver.getZ(i2);

  // Centroid velocity from Verlet (pos - prevPos) * tickRate
  const vx =
    (x0 -
      solver.getPrevPositionX(i0) +
      (x1 - solver.getPrevPositionX(i1)) +
      (x2 - solver.getPrevPositionX(i2))) *
    (tickRate / 3);
  const vy =
    (y0 -
      solver.getPrevPositionY(i0) +
      (y1 - solver.getPrevPositionY(i1)) +
      (y2 - solver.getPrevPositionY(i2))) *
    (tickRate / 3);

  // Relative wind = true wind - surface velocity
  const relX = windX - vx;
  const relY = windY - vy;
  const relSpeed = Math.hypot(relX, relY);
  if (relSpeed < 0.01) return [0, 0, 0];

  // Edge vectors
  const e1x = x1 - x0;
  const e1y = y1 - y0;
  const e1z = z1 - z0;
  const e2x = x2 - x0;
  const e2y = y2 - y0;
  const e2z = z2 - z0;

  // 3D cross product → face normal
  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  const nLen = Math.hypot(nx, ny, nz);
  if (nLen < 0.0001) return [0, 0, 0];

  // Triangle area = 0.5 * |cross product|
  const area = nLen * 0.5;

  // Normalize normal
  const nnx = nx / nLen;
  const nny = ny / nLen;
  const nnz = nz / nLen;

  // Relative wind direction (normalized, treat as 2D with z=0)
  const wdx = relX / relSpeed;
  const wdy = relY / relSpeed;

  // Angle of attack: angle between wind direction and face normal
  // dot(wind3d, normal) where wind3d = (wdx, wdy, 0)
  const dot = wdx * nnx + wdy * nny;
  // The angle of attack is the complement: cos(aoa) = |dot| means aoa = acos(|dot|)
  // But for a sail, aoa is angle between wind and the surface plane, not the normal
  const sinAoa = Math.abs(dot); // sin of angle between wind and surface
  const aoa = Math.asin(clamp(sinAoa, 0, 1));

  // Dynamic pressure from relative wind
  const q = 0.5 * RHO_AIR * relSpeed * relSpeed;

  // Lift and drag coefficients
  const cl = getSailLiftCoefficient(aoa) * liftScale;
  const cd = computeDragCoefficient(aoa) * dragScale;

  const liftMag = cl * q * area * LBF_TO_ENGINE;
  const dragMag = cd * q * area * LBF_TO_ENGINE;

  // Drag force: along relative wind direction
  const fdx = wdx * dragMag;
  const fdy = wdy * dragMag;

  // Lift force: perpendicular to wind, in the direction the normal faces
  // Lift pushes the sail in the direction of the face normal (leeward)
  // Project normal onto plane perpendicular to wind
  const normalDotWind = nnx * wdx + nny * wdy;
  let liftDirX = nnx - normalDotWind * wdx;
  let liftDirY = nny - normalDotWind * wdy;
  let liftDirZ = nnz;
  const liftDirLen = Math.hypot(liftDirX, liftDirY, liftDirZ);
  if (liftDirLen > 0.001) {
    liftDirX /= liftDirLen;
    liftDirY /= liftDirLen;
    liftDirZ /= liftDirLen;
  } else {
    liftDirX = 0;
    liftDirY = 0;
    liftDirZ = 0;
  }

  const fx = fdx + liftDirX * liftMag;
  const fy = fdy + liftDirY * liftMag;
  const fz = liftDirZ * liftMag;

  return [fx, fy, fz];
}
