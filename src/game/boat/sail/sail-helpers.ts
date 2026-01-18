import { degToRad } from "../../../core/util/MathUtil";
import { V2d } from "../../../core/Vector";

// ============================================================================
// Sail Airfoil Physics
// ============================================================================

// Default sail chord (depth from luff to leech) in feet
// A typical dinghy mainsail might be 5-6 ft from luff to leech
export const DEFAULT_SAIL_CHORD = 5.0; // ft

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

export const STALL_ANGLE = degToRad(15);

/**
 * Calculate the lift coefficient for a sail at a given angle of attack.
 * Based on thin airfoil theory: Cl ≈ 2π·sin(α) before stall.
 * Used by wind modifiers to determine circulation strength.
 */
export function getSailLiftCoefficient(angleOfAttack: number): number {
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

  // Sign from cos(angleOfAttack) ensures correct direction
  cl *= Math.sign(Math.cos(angleOfAttack));

  return cl;
}

/** Check if a sail is stalled at the given angle of attack. */
export function isSailStalled(angleOfAttack: number): boolean {
  const alpha = Math.abs(angleOfAttack);
  const effectiveAlpha = alpha > Math.PI / 2 ? Math.PI - alpha : alpha;
  return effectiveAlpha > STALL_ANGLE;
}
