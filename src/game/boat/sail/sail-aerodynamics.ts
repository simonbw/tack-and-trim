import type DynamicBody from "../../../core/physics/body/DynamicBody";
import { clamp, degToRad } from "../../../core/util/MathUtil";
import { V } from "../../../core/Vector";
import { RHO_AIR } from "../../fluid-dynamics";
import { SEPARATION_DECAY_RATE } from "../../wind/WindConstants";
import type { SailSegment } from "./SailSegment";

const STALL_ANGLE = degToRad(15);

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
): void {
  const { flow, length, tangent } = segment;

  if (flow.speed < 0.01 || length < 0.001) return;

  // Dynamic pressure: q = 0.5 * ρ * v²
  const q = 0.5 * RHO_AIR * flow.speed * flow.speed;
  const area = length * chord * forceScale;

  // Compute angle of attack
  const flowDir = flow.velocity.normalize();
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
      body.applyForce(buffetDir.mul(buffet));
    }
  }

  // Apply lift (perpendicular to flow) and drag (opposing flow)
  // Lift direction depends on which side of the flow the sail is
  const liftDir = flowDir.rotate90cw();
  const liftSign = Math.sign(Math.sin(aoa));
  const liftForce = liftDir.mul(lift * liftSign);
  const dragForce = flowDir.mul(-drag);

  const totalForce = liftForce.add(dragForce);
  body.applyForce(totalForce);
}
