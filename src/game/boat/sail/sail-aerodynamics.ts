import type { DynamicBody } from "../../../core/physics/body/DynamicBody";
import { clamp, degToRad } from "../../../core/util/MathUtil";
import { V } from "../../../core/Vector";
import { RHO_AIR } from "../../fluid-dynamics";
import { SEPARATION_DECAY_RATE } from "../../world/wind/WindConstants";
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
      const buffetDir = V(Math.random() - 0.5, Math.random() - 0.5).normalize();
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
}
