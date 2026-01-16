import { degToRad } from "../../../core/util/MathUtil";
import { V2d } from "../../../core/Vector";
import { ForceMagnitudeFn, RHO_AIR } from "../../fluid-dynamics";

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

/**
 * Create a lift magnitude function for sail airfoil behavior.
 * Uses proper fluid dynamics: F = 0.5 * ρ_air * v² * Cl * A
 * @param chord - Sail chord (depth) in feet
 * @param camber - Sail camber (curvature)
 * @param rho - Air density in slugs/ft³ (default: sea level air)
 */
export function sailLift(
  chord: number,
  camber: number,
  rho: number = RHO_AIR,
): ForceMagnitudeFn {
  return ({ angleOfAttack, speed, edgeLength }) => {
    // Use effective angle (0 to 90°) for coefficient calculation
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

    // Proper fluid dynamics formula: F = 0.5 * ρ * v² * Cl * A
    // The sin(angleOfAttack) factor projects the force appropriately
    const area = edgeLength * chord;
    const dynamicPressure = 0.5 * rho * speed * speed;
    return Math.sin(angleOfAttack) * cl * dynamicPressure * area;
  };
}

/**
 * Create a drag magnitude function for sail airfoil behavior.
 * Uses proper fluid dynamics: F = 0.5 * ρ_air * v² * Cd * A
 * @param chord - Sail chord (depth) in feet
 * @param rho - Air density in slugs/ft³ (default: sea level air)
 */
export function sailDrag(
  chord: number,
  rho: number = RHO_AIR,
): ForceMagnitudeFn {
  return ({ angleOfAttack, speed, edgeLength }) => {
    // Use effective angle (0 to 90°) for coefficient calculation
    const alpha = Math.abs(angleOfAttack);
    const effectiveAlpha = alpha > Math.PI / 2 ? Math.PI - alpha : alpha;

    // Drag coefficient: base + induced + stall penalty
    const baseDrag = 0.02;
    const inducedDrag = 0.1 * effectiveAlpha * effectiveAlpha;
    const stallDrag =
      effectiveAlpha > STALL_ANGLE ? 0.5 * (effectiveAlpha - STALL_ANGLE) : 0;
    const cd = baseDrag + inducedDrag + stallDrag;

    // Proper fluid dynamics formula: F = 0.5 * ρ * v² * Cd * A
    const area = edgeLength * chord;
    const dynamicPressure = 0.5 * rho * speed * speed;
    return Math.sin(angleOfAttack) * cd * dynamicPressure * area;
  };
}
export const CAMBER_LIFT_FACTOR = 0.0;
export const STALL_ANGLE = degToRad(15);

/**
 * Calculate the lift coefficient for a sail at a given angle of attack.
 * Based on thin airfoil theory: Cl ≈ 2π·sin(α) before stall.
 * Used by wind modifiers to determine circulation strength.
 */
export function getSailLiftCoefficient(
  angleOfAttack: number,
  camber: number = 0,
): number {
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

  // Camber increases lift
  cl += Math.abs(camber) * CAMBER_LIFT_FACTOR;

  return cl;
}

/** Check if a sail is stalled at the given angle of attack. */
export function isSailStalled(angleOfAttack: number): boolean {
  const alpha = Math.abs(angleOfAttack);
  const effectiveAlpha = alpha > Math.PI / 2 ? Math.PI - alpha : alpha;
  return effectiveAlpha > STALL_ANGLE;
}
