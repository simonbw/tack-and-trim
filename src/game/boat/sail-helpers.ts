import { V2d } from "../../core/Vector";
import { ForceMagnitudeFn, GLOBAL_FORCE_SCALE } from "../fluid-dynamics";
import { CAMBER_LIFT_FACTOR, STALL_ANGLE } from "./Sail";

// ============================================================================
// Sail Airfoil Physics
// ============================================================================
/**
 * Calculate camber from three points (prev, current, next).
 * Returns how far the middle point deviates from the chord line,
 * normalized by chord length. Positive = curved toward the normal.
 */
export function calculateCamber(prev: V2d, current: V2d, next: V2d): number {
  const chord = next.sub(prev);
  const chordLength = chord.magnitude;
  if (chordLength < 0.001) return 0;

  const chordMidpoint = prev.add(chord.mul(0.5));
  const deviation = current.sub(chordMidpoint);

  const chordNormal = chord.normalize().rotate90cw();
  const camberDistance = deviation.dot(chordNormal);

  return camberDistance / chordLength;
}

/**
 * Create a lift magnitude function for sail airfoil behavior.
 * Unlike flat plates, airfoil lift is proportional to sin(α) * Cl(α),
 * not sin(α) * cos(α). Camber increases lift coefficient.
 */
export function sailLift(scale: number, camber: number): ForceMagnitudeFn {
  return ({ angleOfAttack, speed, edgeLength }) => {
    const alpha = Math.abs(angleOfAttack);

    // Lift coefficient: linear region up to stall, then exponential decay
    let cl: number;
    if (alpha < STALL_ANGLE) {
      cl = 2 * Math.PI * Math.sin(alpha) * Math.sign(angleOfAttack);
    } else {
      const peak = 2 * Math.PI * Math.sin(STALL_ANGLE);
      const decay = Math.exp(-3 * (alpha - STALL_ANGLE));
      cl = peak * decay * Math.sign(angleOfAttack);
    }

    // Camber increases lift
    cl += Math.abs(camber) * CAMBER_LIFT_FACTOR;

    return (
      Math.sin(angleOfAttack) *
      cl *
      speed *
      speed *
      edgeLength *
      scale *
      GLOBAL_FORCE_SCALE
    );
  };
}

/**
 * Create a drag magnitude function for sail airfoil behavior.
 */
export function sailDrag(scale: number): ForceMagnitudeFn {
  return ({ angleOfAttack, speed, edgeLength }) => {
    const alpha = Math.abs(angleOfAttack);

    // Drag coefficient: base + induced + stall penalty
    const baseDrag = 0.02;
    const inducedDrag = 0.1 * alpha * alpha;
    const stallDrag = alpha > STALL_ANGLE ? 0.5 * (alpha - STALL_ANGLE) : 0;
    const cd = baseDrag + inducedDrag + stallDrag;

    return (
      Math.sin(angleOfAttack) *
      cd *
      speed *
      speed *
      edgeLength *
      scale *
      GLOBAL_FORCE_SCALE
    );
  };
}
