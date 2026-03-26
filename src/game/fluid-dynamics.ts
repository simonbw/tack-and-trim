import { DynamicBody } from "../core/physics/body/DynamicBody";
import { degToRad } from "../core/util/MathUtil";
import { V, V2d } from "../core/Vector";
import { RHO_WATER, RHO_AIR } from "./physics-constants";

// Re-export so existing importers don't break
export { RHO_WATER, RHO_AIR };

// Foil chord (depth) dimensions in feet
export const RUDDER_CHORD = 1.5; // ft - typical dinghy rudder depth
export const KEEL_CHORD = 1.25; // ft - centerboard/daggerboard chord

// =============================================================================
// Simulation Constants
// =============================================================================

const MAX_RELATIVE_SPEED = 15; // ft/s - cap for numerical stability (~9 kts)

// The physics engine uses mass in "lbs" but F=ma with gravity=32.174 ft/s²,
// effectively treating mass as slugs. Fluid formulas with ρ in slugs/ft³
// produce force in lbf, so we multiply by g to convert to engine force units.
const LBF_TO_ENGINE = 32.174;

// ============================================================================
// Types
// ============================================================================

export type FluidVelocityFn = (point: V2d) => V2d;

export type ForceMagnitudeFn = (params: {
  angleOfAttack: number;
  speed: number;
  edgeLength: number;
}) => number;
type ForceMagnitudeParams = Parameters<ForceMagnitudeFn>[0];

/**
 * Result of computing fluid forces at a single application point.
 * Force is in world frame; application point is in body-local frame.
 */
export interface FluidForceResult {
  /** World-frame force X component */
  fx: number;
  /** World-frame force Y component */
  fy: number;
  /** Body-local application point X */
  localX: number;
  /** Body-local application point Y */
  localY: number;
}

// Pre-allocated result array to avoid allocation on hot path
const _forceResults: FluidForceResult[] = [
  { fx: 0, fy: 0, localX: 0, localY: 0 },
  { fx: 0, fy: 0, localX: 0, localY: 0 },
];

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Compute fluid forces on a single edge without applying them.
 * Returns up to 2 force results (one per edge endpoint).
 * The edge is defined by two points in body-local coordinates.
 *
 * @returns Number of valid results written into the `results` parameter.
 *          Results are written into elements [0] and [1] of the array.
 */
export function computeFluidForces(
  body: DynamicBody,
  v1: V2d,
  v2: V2d,
  getLiftMagnitude: ForceMagnitudeFn,
  getDragMagnitude: ForceMagnitudeFn,
  getFluidVelocity: FluidVelocityFn = () => V(0, 0),
  results: FluidForceResult[] = _forceResults,
): number {
  const v1World = body.toWorldFrame(v1);
  const v2World = body.toWorldFrame(v2);

  const edge = v2World.sub(v1World);
  const edgeLength = edge.magnitude;
  if (edgeLength < 0.001) return 0;
  edge.inormalize();
  const edgeNormal = edge.rotate90cw();

  const halfLength = edgeLength / 2;
  let count = 0;

  if (
    computeFluidForceAtPoint(
      body,
      v1,
      v1World,
      edge,
      edgeNormal,
      halfLength,
      getLiftMagnitude,
      getDragMagnitude,
      getFluidVelocity,
      results[0],
    )
  ) {
    count++;
  }

  if (
    computeFluidForceAtPoint(
      body,
      v2,
      v2World,
      edge,
      edgeNormal,
      halfLength,
      getLiftMagnitude,
      getDragMagnitude,
      getFluidVelocity,
      results[count],
    )
  ) {
    count++;
  }

  return count;
}

/**
 * Apply fluid forces to a single edge (legacy convenience wrapper).
 * Computes forces and applies them directly to the body.
 */
export function applyFluidForces(
  body: DynamicBody,
  v1: V2d,
  v2: V2d,
  getLiftMagnitude: ForceMagnitudeFn,
  getDragMagnitude: ForceMagnitudeFn,
  getFluidVelocity: FluidVelocityFn = () => V(0, 0),
) {
  const count = computeFluidForces(
    body,
    v1,
    v2,
    getLiftMagnitude,
    getDragMagnitude,
    getFluidVelocity,
  );

  for (let i = 0; i < count; i++) {
    const r = _forceResults[i];
    const relPoint = body.vectorToWorldFrame(V(r.localX, r.localY));
    body.applyForce(V(r.fx, r.fy), relPoint);
  }
}

function computeFluidForceAtPoint(
  body: DynamicBody,
  localPoint: V2d,
  worldPoint: V2d,
  edge: V2d,
  edgeNormal: V2d,
  edgeLength: number,
  getLiftMagnitude: ForceMagnitudeFn,
  getDragMagnitude: ForceMagnitudeFn,
  getFluidVelocity: FluidVelocityFn,
  out: FluidForceResult,
): boolean {
  // Calculate relative velocity (body velocity minus fluid velocity = apparent flow)
  const r = worldPoint.sub(V(body.position));
  const pointVelocity = V(body.velocity).add(
    r.rotate90ccw().mul(body.angularVelocity),
  );
  const fluidVelocity = getFluidVelocity(worldPoint);
  const relativeVelocity = pointVelocity.sub(fluidVelocity);

  const rawSpeed = relativeVelocity.magnitude;
  if (rawSpeed < 0.0001) return false;
  const speed = Math.min(rawSpeed, MAX_RELATIVE_SPEED);
  const velDir = relativeVelocity.normalize();

  const velDotNormal = velDir.dot(edgeNormal);
  const velDotEdge = velDir.dot(edge);

  // Skip if flow is from behind the surface
  if (velDotNormal < 0) return false;

  // Calculate angle of attack (angle between flow and edge/chord)
  const angleOfAttack = Math.atan2(velDotNormal, velDotEdge);

  // Get magnitudes from caller-provided functions
  const params: ForceMagnitudeParams = {
    angleOfAttack,
    speed,
    edgeLength,
  };
  const dragMag = getDragMagnitude(params);
  const liftMag = getLiftMagnitude(params);

  // Compute forces: drag opposes motion, lift is perpendicular to flow
  const drag = velDir.mul(-dragMag);
  const lift = velDir.rotate90cw().mul(-liftMag);
  const totalForce = drag.add(lift);

  out.fx = totalForce.x;
  out.fy = totalForce.y;
  out.localX = localPoint.x;
  out.localY = localPoint.y;
  return true;
}

// ============================================================================
// Flat Plate Model (for hull edges)
// ============================================================================

/**
 * Create a drag magnitude function for flat plate behavior.
 * Drag proportional to how face-on the surface is to flow.
 * Uses proper fluid dynamics: F = 0.5 * ρ * v² * Cd * A
 * @param chord - The depth/thickness of the plate in feet
 * @param rho - Fluid density in slugs/ft³ (default: water)
 */
export function flatPlateDrag(
  chord: number,
  rho: number = RHO_WATER,
): ForceMagnitudeFn {
  return ({ angleOfAttack, speed, edgeLength }) => {
    // Flat plate drag coefficient: Cd = sin(α) (projected area)
    const cd = Math.abs(Math.sin(angleOfAttack));
    const area = edgeLength * chord;
    const dynamicPressure = 0.5 * rho * speed * speed;
    return cd * dynamicPressure * area;
  };
}

// ============================================================================
// Symmetric Foil Model (for keel, rudder - NACA-style symmetric hydrofoils)
// ============================================================================

const FOIL_STALL_ANGLE = degToRad(15); // ~15 degrees - typical for symmetric foils

/**
 * Create a lift magnitude function for symmetric foil behavior.
 * Based on thin airfoil theory: Cl ≈ 2π·sin(α) before stall.
 * Uses proper fluid dynamics: F = 0.5 * ρ * v² * Cl * A
 * @param chord - The chord (depth) of the foil in feet
 * @param rho - Fluid density in slugs/ft³ (default: water)
 */
export function foilLift(
  chord: number,
  rho: number = RHO_WATER,
): ForceMagnitudeFn {
  return ({ angleOfAttack, speed, edgeLength }) => {
    // Use the effective angle (0 to 90°) for coefficient calculation
    // but preserve the sign from cos(angleOfAttack) for correct force direction
    const alpha = Math.abs(angleOfAttack);
    const effectiveAlpha = alpha > Math.PI / 2 ? Math.PI - alpha : alpha;

    // Lift coefficient based on thin airfoil theory
    let cl: number;
    if (effectiveAlpha < FOIL_STALL_ANGLE) {
      // Linear region: Cl = 2π·sin(α)
      cl = 2 * Math.PI * Math.sin(effectiveAlpha);
    } else {
      // Post-stall: gradual decay
      const peak = 2 * Math.PI * Math.sin(FOIL_STALL_ANGLE);
      const decay = Math.exp(-2 * (effectiveAlpha - FOIL_STALL_ANGLE));
      cl = peak * decay;
    }

    // Sign from cos(angleOfAttack) ensures correct force direction
    cl *= Math.sign(Math.cos(angleOfAttack));

    // Proper fluid dynamics formula: F = 0.5 * ρ * v² * Cl * A
    const area = edgeLength * chord;
    const dynamicPressure = 0.5 * rho * speed * speed;
    return cl * dynamicPressure * area;
  };
}

/**
 * Create a drag magnitude function for symmetric foil behavior.
 * Lower base drag than flat plate, with induced drag and stall penalty.
 * Uses proper fluid dynamics: F = 0.5 * ρ * v² * Cd * A
 * @param chord - The chord (depth) of the foil in feet
 * @param rho - Fluid density in slugs/ft³ (default: water)
 */
export function foilDrag(
  chord: number,
  rho: number = RHO_WATER,
): ForceMagnitudeFn {
  return ({ angleOfAttack, speed, edgeLength }) => {
    // Use effective angle (0 to 90°) for coefficient calculation
    const alpha = Math.abs(angleOfAttack);
    const effectiveAlpha = alpha > Math.PI / 2 ? Math.PI - alpha : alpha;

    // Drag components:
    // - Base drag: minimal for streamlined foil
    // - Induced drag: proportional to α² (lift-induced)
    // - Stall penalty: significant increase after stall
    const baseDrag = 0.01;
    const inducedDrag = 0.15 * effectiveAlpha * effectiveAlpha;
    const stallDrag =
      effectiveAlpha > FOIL_STALL_ANGLE
        ? 0.8 * (effectiveAlpha - FOIL_STALL_ANGLE)
        : 0;
    const cd = baseDrag + inducedDrag + stallDrag;

    // Proper fluid dynamics formula: F = 0.5 * ρ * v² * Cd * A
    const area = edgeLength * chord;
    const dynamicPressure = 0.5 * rho * speed * speed;
    return cd * dynamicPressure * area;
  };
}

// ============================================================================
// Skin Friction (viscous drag from water flowing along hull surface)
// ============================================================================

/**
 * Apply skin friction force to a body.
 * This is viscous drag proportional to wetted area and velocity squared.
 * Unlike form drag, it always opposes motion regardless of hull orientation.
 * Uses proper fluid dynamics: F = 0.5 * ρ * v² * Cf * A
 * @param body - The physics body to apply force to
 * @param wettedArea - Wetted surface area in ft²
 * @param frictionCoefficient - Skin friction coefficient Cf (dimensionless, typically 0.003-0.004)
 * @param getFluidVelocity - Function to get fluid velocity at a point
 * @param rho - Fluid density in slugs/ft³ (default: water)
 */
export function applySkinFriction(
  body: DynamicBody,
  wettedArea: number,
  frictionCoefficient: number,
  getFluidVelocity: FluidVelocityFn = () => V(0, 0),
  rho: number = RHO_WATER,
) {
  const fluidVelocity = getFluidVelocity(V(body.position));
  const relativeVelocity = V(body.velocity).sub(fluidVelocity);

  const speed = relativeVelocity.magnitude;
  if (speed < 0.0001) return;

  const cappedSpeed = Math.min(speed, MAX_RELATIVE_SPEED);

  // Proper skin friction formula: F = 0.5 * ρ * v² * Cf * A
  // Result is in lbf; convert to engine force units
  const dynamicPressure = 0.5 * rho * cappedSpeed * cappedSpeed;
  const forceMagnitude =
    frictionCoefficient * dynamicPressure * wettedArea * LBF_TO_ENGINE;

  const force = relativeVelocity.normalize().mul(-forceMagnitude);

  // Apply at center of mass (no torque)
  body.applyForce(force, V());
}

/**
 * Compute skin friction force at a specific point on the hull.
 * Returns the force components in world frame.
 * Used for distributed 3D skin friction where forces are applied at
 * multiple hull surface points with 3D application coordinates.
 *
 * @param body - The physics body (for velocity sampling)
 * @param worldPoint - World-space position of the sample point
 * @param area - Wetted surface area patch for this point (ft²)
 * @param frictionCoefficient - Skin friction coefficient Cf
 * @param fluidVelocity - Water velocity at this point (world frame)
 * @param rho - Fluid density in slugs/ft³ (default: water)
 * @returns Force vector {fx, fy, fz} or null if too slow to compute
 */
export function computeSkinFrictionAtPoint(
  body: DynamicBody,
  worldPoint: V2d,
  area: number,
  frictionCoefficient: number,
  fluidVelocity: V2d,
  pointZVelocity: number = 0,
  rho: number = RHO_WATER,
): { fx: number; fy: number; fz: number } | null {
  // Calculate relative velocity at this point
  const r = worldPoint.sub(V(body.position));
  const pointVelocity = V(body.velocity).add(
    r.rotate90ccw().mul(body.angularVelocity),
  );

  // 2D relative velocity (hull vs water)
  const relVx = pointVelocity.x - fluidVelocity.x;
  const relVy = pointVelocity.y - fluidVelocity.y;
  // Vertical relative velocity (from roll/pitch rotation)
  const relVz = pointZVelocity;

  const speed3D = Math.sqrt(relVx * relVx + relVy * relVy + relVz * relVz);
  if (speed3D < 0.0001) return null;

  const cappedSpeed = Math.min(speed3D, MAX_RELATIVE_SPEED);

  // F = 0.5 * ρ * v² * Cf * A, converted to engine units
  const dynamicPressure = 0.5 * rho * cappedSpeed * cappedSpeed;
  const forceMagnitude =
    frictionCoefficient * dynamicPressure * area * LBF_TO_ENGINE;

  // Force opposes relative velocity (normalized)
  const invSpeed = -forceMagnitude / speed3D;
  return {
    fx: relVx * invSpeed,
    fy: relVy * invSpeed,
    fz: relVz * invSpeed,
  };
}
