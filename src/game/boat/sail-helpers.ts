import { degToRad } from "../../core/util/MathUtil";
import { V2d } from "../../core/Vector";
import { ForceMagnitudeFn, GLOBAL_FORCE_SCALE } from "../fluid-dynamics";

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
    // Use effective angle (0 to 90°) for coefficient calculation
    // This ensures symmetric behavior regardless of which edge direction is active
    const alpha = Math.abs(angleOfAttack);
    const effectiveAlpha = alpha > Math.PI / 2 ? Math.PI - alpha : alpha;

    // Lift coefficient: linear region up to stall, then exponential decay
    let cl: number;
    if (effectiveAlpha < STALL_ANGLE) {
      cl = 2 * Math.PI * Math.sin(effectiveAlpha);
    } else {
      const peak = 2 * Math.PI * Math.sin(STALL_ANGLE);
      const decay = Math.exp(-3 * (effectiveAlpha - STALL_ANGLE));
      cl = peak * decay;
    }

    // Sign from cos(angleOfAttack) ensures correct force direction
    cl *= Math.sign(Math.cos(angleOfAttack));

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

/** Create a drag magnitude function for sail airfoil behavior. */
export function sailDrag(scale: number): ForceMagnitudeFn {
  return ({ angleOfAttack, speed, edgeLength }) => {
    // Use effective angle (0 to 90°) for coefficient calculation
    // This ensures symmetric behavior regardless of which edge direction is active
    const alpha = Math.abs(angleOfAttack);
    const effectiveAlpha = alpha > Math.PI / 2 ? Math.PI - alpha : alpha;

    // Drag coefficient: base + induced + stall penalty
    const baseDrag = 0.02;
    const inducedDrag = 0.1 * effectiveAlpha * effectiveAlpha;
    const stallDrag =
      effectiveAlpha > STALL_ANGLE ? 0.5 * (effectiveAlpha - STALL_ANGLE) : 0;
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
export const CAMBER_LIFT_FACTOR = 0.0;
export const STALL_ANGLE = degToRad(15);
