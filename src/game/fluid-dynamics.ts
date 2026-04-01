import { DynamicBody } from "../core/physics/body/DynamicBody";
import { degToRad } from "../core/util/MathUtil";
import { V, V2d } from "../core/Vector";
import { RHO_WATER, RHO_AIR, LBF_TO_ENGINE } from "./physics-constants";

// Re-export so existing importers don't break
export { RHO_WATER, RHO_AIR };

// Foil chord (depth) dimensions in feet
export const RUDDER_CHORD = 1.5; // ft - typical dinghy rudder depth
export const KEEL_CHORD = 1.25; // ft - centerboard/daggerboard chord

// =============================================================================
// Simulation Constants
// =============================================================================

const MAX_RELATIVE_SPEED = 25; // ft/s - cap for numerical stability (~15 kts)

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
    // Flat plate drag coefficient: Cd = 1.28 · sin(α)
    // The 1.28 factor comes from Kirchhoff free-streamline theory, accounting
    // for the wake pressure deficit behind a flat plate in a real fluid.
    const cd = 1.28 * Math.abs(Math.sin(angleOfAttack));
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
      // Post-stall: simplified decay model. Exponent of 1.5 gives gradual
      // falloff — real foils and sails maintain partial lift well past stall.
      const peak = 2 * Math.PI * Math.sin(FOIL_STALL_ANGLE);
      const decay = Math.exp(-1.5 * (effectiveAlpha - FOIL_STALL_ANGLE));
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
 * Uses lifting-line theory for induced drag and Kirchhoff flat-plate
 * model for post-stall saturation.
 * Uses proper fluid dynamics: F = 0.5 * ρ * v² * Cd * A
 * @param chord - The chord (depth) of the foil in feet
 * @param aspectRatio - Aspect ratio AR = span / chord (dimensionless)
 * @param rho - Fluid density in slugs/ft³ (default: water)
 */
export function foilDrag(
  chord: number,
  aspectRatio: number,
  rho: number = RHO_WATER,
): ForceMagnitudeFn {
  // Oswald efficiency factor — accounts for non-elliptical lift distribution.
  // e ≈ 0.9 is typical for well-designed symmetric foils.
  const e = 0.9;

  // Compute the lift coefficient at the stall angle for the transition point.
  // Cl = 2π·sin(α) from thin airfoil theory.
  const clAtStall = 2 * Math.PI * Math.sin(FOIL_STALL_ANGLE);

  // Induced drag at stall: Cd_i = Cl² / (π · AR · e)
  // This is the maximum induced drag before we switch to the flat-plate model.
  const cdInducedAtStall =
    (clAtStall * clAtStall) / (Math.PI * aspectRatio * e);

  return ({ angleOfAttack, speed, edgeLength }) => {
    // Use effective angle (0 to 90°) for coefficient calculation
    const alpha = Math.abs(angleOfAttack);
    const effectiveAlpha = alpha > Math.PI / 2 ? Math.PI - alpha : alpha;

    let cd: number;

    // Minimum profile drag for symmetric NACA foil section (Cd0 ≈ 0.006-0.008)
    const cdBase = 0.007;

    if (effectiveAlpha < FOIL_STALL_ANGLE) {
      // Pre-stall regime: base profile drag + induced drag from lifting-line theory.
      //
      // Induced drag formula (Prandtl lifting-line theory):
      //   Cd_induced = Cl² / (π · AR · e)
      // where:
      //   Cl  = lift coefficient = 2π·sin(α) (thin airfoil theory)
      //   AR  = aspect ratio = span / chord
      //   e   = Oswald efficiency factor (≈ 0.9)
      //   π   = pi
      //
      // This is the minimum induced drag for a finite wing; the 1/AR dependence
      // means high-aspect-ratio foils (long, narrow) have less induced drag.
      const cl = 2 * Math.PI * Math.sin(effectiveAlpha);
      const cdInduced = (cl * cl) / (Math.PI * aspectRatio * e);
      cd = cdBase + cdInduced;
    } else {
      // Post-stall regime: transition from foil drag to flat-plate behavior.
      //
      // Flat-plate normal drag (Kirchhoff theory):
      //   Cd_flatplate = 1.28 · sin²(α)
      // This naturally saturates at Cd = 1.28 at α = 90° (broadside to flow),
      // is near zero at small α, and rises smoothly through stall.
      //
      // We take the maximum of:
      //   - The foil drag at stall (continuity with pre-stall)
      //   - The flat-plate drag model
      // This ensures a smooth, physically bounded transition.
      const CD_FLAT_PLATE = 1.28;
      const sinAlpha = Math.sin(effectiveAlpha);
      const cdFlatPlate = CD_FLAT_PLATE * sinAlpha * sinAlpha;
      cd = Math.max(cdBase + cdInducedAtStall, cdFlatPlate);
    }

    // Proper fluid dynamics formula: F = 0.5 * ρ * v² * Cd * A
    const area = edgeLength * chord;
    const dynamicPressure = 0.5 * rho * speed * speed;
    return cd * dynamicPressure * area;
  };
}

// ============================================================================
// Hydrofoil 3D Force Computation (shared by keel and rudder)
// ============================================================================

/**
 * Result of computing 3D hydrofoil forces at a single application point.
 * Includes heel-adjusted horizontal forces and vertical righting force.
 */
export interface HydrofoilForceResult {
  /** World-frame horizontal force X */
  fx: number;
  /** World-frame horizontal force Y */
  fy: number;
  /** Vertical force from heel tilt (righting/heeling force) */
  fz: number;
  /** Body-local application point X */
  localX: number;
  /** Body-local application point Y */
  localY: number;
}

/**
 * Compute 3D hydrofoil forces for a set of foil edge vertices.
 *
 * Handles:
 * - Heel-adjusted effective chord (foil loses area as hull heels)
 * - Symmetric foil lift and drag via `foilLift`/`foilDrag`
 * - Forward and reversed edge iteration for symmetric force computation
 * - 3D force decomposition: lateral force component is tilted by hull roll,
 *   producing a vertical (fz) righting/heeling force
 *
 * Each edge pair produces up to 2 results per direction × 2 directions = 4 results.
 * For N vertices there are (N-1) edge pairs, so max results = 4 × (N-1).
 * Pre-allocate the results array accordingly.
 *
 * @param body - The physics body the foil is attached to (used for velocity computation in computeFluidForces)
 * @param vertices - Foil edge vertices in body-local coordinates
 * @param chord - Foil chord length (ft)
 * @param aspectRatio - Aspect ratio AR = span / chord (dimensionless)
 * @param roll - Hull roll angle (radians) — used for heel factor and 3D decomposition
 * @param bodyAngle - Angle of the body whose frame forces are decomposed relative to
 * @param getLiftMagnitude - Lift magnitude function (caller may wrap foilLift to apply multipliers)
 * @param getDragMagnitude - Drag magnitude function
 * @param getWaterVelocity - Callback returning water velocity at a world-space point
 * @param results - Pre-allocated output buffer for force results
 * @returns Number of valid results written to the results array
 */
export function computeHydrofoilForces(
  body: DynamicBody,
  vertices: ReadonlyArray<V2d>,
  roll: number,
  bodyAngle: number,
  getLiftMagnitude: ForceMagnitudeFn,
  getDragMagnitude: ForceMagnitudeFn,
  getWaterVelocity: FluidVelocityFn,
  results: HydrofoilForceResult[],
  fluidForceResults: FluidForceResult[],
): number {
  // Cache trig values for 3D force decomposition
  const cosRoll = Math.cos(roll);
  const sinRoll = Math.sin(roll);
  const cosA = Math.cos(bodyAngle);
  const sinA = Math.sin(bodyAngle);

  let totalCount = 0;

  // Iterate all edge pairs, both forward and reversed
  for (let vi = 0; vi < vertices.length - 1; vi++) {
    const start = vertices[vi];
    const end = vertices[vi + 1];

    for (let dir = 0; dir < 2; dir++) {
      const a = dir === 0 ? start : end;
      const b = dir === 0 ? end : start;

      const count = computeFluidForces(
        body,
        a,
        b,
        getLiftMagnitude,
        getDragMagnitude,
        getWaterVelocity,
        fluidForceResults,
      );

      for (let i = 0; i < count; i++) {
        const r = fluidForceResults[i];

        // 3D force decomposition: rotate lateral force component by heel angle.
        // The foil tilts with the boat's heel, so its lift vector tilts too.
        // Decompose world-frame force into longitudinal (along heading) and
        // lateral (perpendicular to heading) components relative to bodyAngle.
        const longitudinal = r.fx * cosA + r.fy * sinA;
        const lateral = -r.fx * sinA + r.fy * cosA;

        // The longitudinal component (drag) stays horizontal regardless of heel.
        // The lateral component (lift) tilts with the foil:
        //   horizontal part = lateral * cos(roll)
        //   vertical part   = lateral * sin(roll) — this provides righting force
        const lateralH = lateral * cosRoll;

        const out = results[totalCount];
        out.fx = longitudinal * cosA - lateralH * sinA;
        out.fy = longitudinal * sinA + lateralH * cosA;
        out.fz = lateral * sinRoll;
        out.localX = r.localX;
        out.localY = r.localY;
        totalCount++;
      }
    }
  }

  return totalCount;
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
