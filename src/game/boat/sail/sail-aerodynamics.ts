import type { DynamicBody } from "../../../core/physics/body/DynamicBody";
import { clamp, degToRad } from "../../../core/util/MathUtil";
import { rUniform } from "../../../core/util/Random";
import { V, V2d } from "../../../core/Vector";
import { RHO_AIR } from "../../fluid-dynamics";
import { SEPARATION_DECAY_RATE } from "../../world/wind/WindConstants";
import type { ClothSolver } from "./ClothSolver";
import type { SailSegment } from "./SailSegment";

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
 * Apply aerodynamic forces to a sail particle based on its segment's flow state.
 * Forces propagate to the hull naturally through constraints.
 *
 * @param body - The dynamic body to apply forces to
 * @param segment - Sail segment with geometry and flow state
 * @param chord - Sail chord length in ft
 * @param forceScale - Scale factor for force (position along sail × hoist amount)
 */
export function applySailForces(
  body: DynamicBody,
  segment: SailSegment,
  chord: number,
  forceScale: number,
  liftScale: number,
  dragScale: number,
  forceAccumulator?: V2d,
): void {
  const { flow, length, tangent } = segment;

  if (flow.speed < 0.01 || length < 0.001) return;

  // Compute apparent wind (flow relative to sail particle)
  const bodyVel = V(body.velocity);
  const apparentWind = flow.velocity.sub(bodyVel);
  const apparentSpeed = apparentWind.magnitude;

  if (apparentSpeed < 0.01) return;

  // Dynamic pressure: q = 0.5 * ρ * v²
  const q = 0.5 * RHO_AIR * apparentSpeed * apparentSpeed;
  const area = length * chord * forceScale;

  // Compute angle of attack from apparent wind
  const flowDir = apparentWind.normalize();
  const dotProduct = clamp(flowDir.dot(tangent), -1, 1);
  const aoa = Math.acos(dotProduct);

  let lift: number;
  let drag: number;

  if (flow.attached) {
    // Attached flow - standard thin airfoil
    const cl = getSailLiftCoefficient(aoa);
    const cd = computeDragCoefficient(aoa);
    lift = cl * q * area;
    drag = cd * q * area;
  } else {
    // Separated flow - reduced lift, increased drag
    const separationFactor = Math.exp(
      -flow.stallDistance * SEPARATION_DECAY_RATE,
    );
    const cl = getSailLiftCoefficient(aoa) * separationFactor * 0.3;
    const cd = computeDragCoefficient(aoa) + 0.5 * (1 - separationFactor);
    lift = cl * q * area;
    drag = cd * q * area;

    // Turbulent buffeting
    if (flow.turbulence > 0.1) {
      const buffet = flow.turbulence * 0.2 * q * area;
      const buffetDir = V(rUniform(-0.5, 0.5), rUniform(-0.5, 0.5)).normalize();
      body.applyForce(buffetDir.mul(buffet * LBF_TO_ENGINE));
    }
  }

  // Lift (perpendicular to flow) and drag (along flow)
  // Use cross product of flow direction and tangent to determine lift side
  const liftDir = flowDir.rotate90cw();
  const cross = flowDir.x * tangent.y - flowDir.y * tangent.x;
  const liftSign = Math.sign(cross);
  const liftForce = liftDir.mul(lift * liftSign * LBF_TO_ENGINE * liftScale);
  const dragForce = flowDir.mul(drag * LBF_TO_ENGINE * dragScale);

  const totalForce = liftForce.add(dragForce);
  body.applyForce(totalForce);
  if (forceAccumulator) {
    forceAccumulator.iadd(totalForce);
  }
}

/**
 * Compute per-triangle wind force for cloth sail simulation.
 * Returns [fx, fy, fz] force to be distributed 1/3 to each vertex.
 *
 * @param solver - ClothSolver with vertex positions
 * @param i0 - First vertex index
 * @param i1 - Second vertex index
 * @param i2 - Third vertex index
 * @param windX - Apparent wind X (world space)
 * @param windY - Apparent wind Y (world space)
 * @param liftScale - Lift coefficient multiplier
 * @param dragScale - Drag coefficient multiplier
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
): [number, number, number] {
  const windSpeed = Math.hypot(windX, windY);
  if (windSpeed < 0.01) return [0, 0, 0];

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

  // Wind direction (normalized, treat as 2D with z=0)
  const wdx = windX / windSpeed;
  const wdy = windY / windSpeed;

  // Angle of attack: angle between wind direction and face normal
  // dot(wind3d, normal) where wind3d = (wdx, wdy, 0)
  const dot = wdx * nnx + wdy * nny;
  // The angle of attack is the complement: cos(aoa) = |dot| means aoa = acos(|dot|)
  // But for a sail, aoa is angle between wind and the surface plane, not the normal
  const sinAoa = Math.abs(dot); // sin of angle between wind and surface
  const aoa = Math.asin(clamp(sinAoa, 0, 1));

  // Dynamic pressure
  const q = 0.5 * RHO_AIR * windSpeed * windSpeed;

  // Lift and drag coefficients
  const cl = getSailLiftCoefficient(aoa) * liftScale;
  const cd = computeDragCoefficient(aoa) * dragScale;

  const liftMag = cl * q * area * LBF_TO_ENGINE;
  const dragMag = cd * q * area * LBF_TO_ENGINE;

  // Drag force: along wind direction
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
