import { clamp, degToRad } from "../../../core/util/MathUtil";
import { LBF_TO_ENGINE, RHO_AIR } from "../../physics-constants";
import type { ClothSolver } from "./ClothSolver";

export const STALL_ANGLE = degToRad(15);

/**
 * Lift coefficient for a sail at a given angle of attack.
 *
 * `aoa` is expected in [0, π/2] — the unsigned angle between the wind and the
 * sail surface. (Callers compute it as `asin(|n · ŵ|)`, so the sign is already
 * absorbed into the lift *direction* — see `computeClothWindForce`.)
 *
 * Pre-stall: thin-airfoil theory, `Cl = 2π·sin(α)`.
 * Post-stall: exponential decay from the peak at `STALL_ANGLE`.
 */
function getSailLiftCoefficient(aoa: number): number {
  if (aoa < STALL_ANGLE) {
    return 2 * Math.PI * Math.sin(aoa);
  }
  const peak = 2 * Math.PI * Math.sin(STALL_ANGLE);
  return peak * Math.exp(-3 * (aoa - STALL_ANGLE));
}

/**
 * Drag coefficient for a sail segment at angle of attack `aoa` ∈ [0, π/2].
 *
 * Base profile drag + induced drag (quadratic in AOA) + a post-stall penalty.
 * The induced term is a strip-theory approximation; it does not couple to the
 * sail's overall aspect ratio.
 */
function computeDragCoefficient(aoa: number): number {
  const baseDrag = 0.02;
  const inducedDrag = 0.1 * aoa * aoa;
  const stallDrag = aoa > STALL_ANGLE ? 0.5 * (aoa - STALL_ANGLE) : 0;
  return baseDrag + inducedDrag + stallDrag;
}

/**
 * Compute the per-triangle wind force for cloth sail simulation.
 *
 * Returns `[fx, fy, fz]`, the total aerodynamic force on the triangle. The
 * caller is expected to split it 1/3 to each vertex.
 *
 * `windX/Y/Z` is the *apparent wind* at the sail's wind-sample point in the
 * world frame — i.e., the true wind minus the boat's 3D velocity at that
 * point. The Z component is non-zero whenever the boat is heaving, rolling,
 * or pitching, even though the wind field itself has no vertical component.
 *
 * The full 3D wind vector flows through both the angle-of-attack calculation
 * and the lift-direction projection, so a heeled sail's effective AOA and
 * its lift's vertical component come out right.
 *
 * @param solver    cloth solver providing positions
 * @param i0,i1,i2  triangle vertex indices
 * @param windX     apparent wind X (world frame)
 * @param windY     apparent wind Y (world frame)
 * @param windZ     apparent wind Z (world frame)
 * @param liftScale lift coefficient multiplier
 * @param dragScale drag coefficient multiplier
 */
export function computeClothWindForce(
  solver: ClothSolver,
  i0: number,
  i1: number,
  i2: number,
  windX: number,
  windY: number,
  windZ: number,
  liftScale: number,
  dragScale: number,
): [number, number, number] {
  const x0 = solver.getPositionX(i0);
  const y0 = solver.getPositionY(i0);
  const z0 = solver.getZ(i0);
  const x1 = solver.getPositionX(i1);
  const y1 = solver.getPositionY(i1);
  const z1 = solver.getZ(i1);
  const x2 = solver.getPositionX(i2);
  const y2 = solver.getPositionY(i2);
  const z2 = solver.getZ(i2);

  const speed = Math.hypot(windX, windY, windZ);
  if (speed < 0.01) return [0, 0, 0];

  // Edge vectors and 3D face normal
  const e1x = x1 - x0;
  const e1y = y1 - y0;
  const e1z = z1 - z0;
  const e2x = x2 - x0;
  const e2y = y2 - y0;
  const e2z = z2 - z0;
  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  const nLen = Math.hypot(nx, ny, nz);
  if (nLen < 0.0001) return [0, 0, 0];

  const area = nLen * 0.5;
  const nnx = nx / nLen;
  const nny = ny / nLen;
  const nnz = nz / nLen;

  const wdx = windX / speed;
  const wdy = windY / speed;
  const wdz = windZ / speed;

  // Angle of attack: angle between wind and sail surface, in [0, π/2].
  // sin(α) = |n · ŵ|, taking the absolute value because the cloth's two sides
  // are aerodynamically symmetric here — lift direction is recovered later
  // from the projected normal.
  const sinAoa = Math.abs(wdx * nnx + wdy * nny + wdz * nnz);
  const aoa = Math.asin(clamp(sinAoa, 0, 1));

  // Dynamic pressure from the apparent wind
  const q = 0.5 * RHO_AIR * speed * speed;

  const cl = getSailLiftCoefficient(aoa) * liftScale;
  const cd = computeDragCoefficient(aoa) * dragScale;

  const liftMag = cl * q * area * LBF_TO_ENGINE;
  const dragMag = cd * q * area * LBF_TO_ENGINE;

  // Drag along the wind direction
  const fdx = wdx * dragMag;
  const fdy = wdy * dragMag;
  const fdz = wdz * dragMag;

  // Lift along the projection of the face normal onto the plane perpendicular
  // to the wind. This points into the leeward half-space (whichever side the
  // sail's +normal currently faces); when the cloth is back-winded its shape
  // flips and the normal flips with it, so the lift direction follows.
  const normalDotWind = nnx * wdx + nny * wdy + nnz * wdz;
  let liftDirX = nnx - normalDotWind * wdx;
  let liftDirY = nny - normalDotWind * wdy;
  let liftDirZ = nnz - normalDotWind * wdz;
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
  const fz = fdz + liftDirZ * liftMag;

  return [fx, fy, fz];
}
