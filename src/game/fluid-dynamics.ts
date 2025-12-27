import p2, { Convex } from "p2";
import { V, V2d } from "../core/Vector";

const MAX_RELATIVE_SPEED = 50;
export const GLOBAL_FORCE_SCALE = 0.005;

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

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Apply fluid forces to all edges of a body's convex shapes.
 */
export function applyFluidForcesToBody(
  body: p2.Body,
  getLiftMagnitude: ForceMagnitudeFn,
  getDragMagnitude: ForceMagnitudeFn,
  getFluidVelocity: FluidVelocityFn = () => V(0, 0)
) {
  for (const shape of body.shapes) {
    if (shape instanceof Convex) {
      for (let i = 0; i < shape.vertices.length; i++) {
        const v1 = V(shape.vertices[i]);
        const v2 = V(shape.vertices[(i + 1) % shape.vertices.length]);
        applyFluidForces(
          body,
          v1,
          v2,
          getLiftMagnitude,
          getDragMagnitude,
          getFluidVelocity
        );
      }
    }
  }
}

/**
 * Apply fluid forces to a single edge.
 * The edge is defined by two points in body-local coordinates.
 */
export function applyFluidForces(
  body: p2.Body,
  v1: V2d,
  v2: V2d,
  getLiftMagnitude: ForceMagnitudeFn,
  getDragMagnitude: ForceMagnitudeFn,
  getFluidVelocity: FluidVelocityFn = () => V(0, 0)
) {
  const v1World = V(0, 0);
  const v2World = V(0, 0);
  body.toWorldFrame(v1World, v1);
  body.toWorldFrame(v2World, v2);

  const edge = v2World.sub(v1World);
  const edgeLength = edge.magnitude;
  if (edgeLength < 0.001) return; // Skip degenerate edges
  edge.inormalize();
  const edgeNormal = edge.rotate90cw();

  // Sample at both endpoints for better accuracy with rotation.
  // Each endpoint is responsible for half the edge length.
  const halfLength = edgeLength / 2;
  applyFluidForcesAtPoint(
    body,
    v1World,
    edge,
    edgeNormal,
    halfLength,
    getLiftMagnitude,
    getDragMagnitude,
    getFluidVelocity
  );
  applyFluidForcesAtPoint(
    body,
    v2World,
    edge,
    edgeNormal,
    halfLength,
    getLiftMagnitude,
    getDragMagnitude,
    getFluidVelocity
  );
}

function applyFluidForcesAtPoint(
  body: p2.Body,
  point: V2d,
  edge: V2d,
  edgeNormal: V2d,
  edgeLength: number,
  getLiftMagnitude: ForceMagnitudeFn,
  getDragMagnitude: ForceMagnitudeFn,
  getFluidVelocity: FluidVelocityFn
) {
  // Calculate relative velocity (body velocity minus fluid velocity = apparent flow)
  const r = point.sub(V(body.position));
  const pointVelocity = V(body.velocity).add(
    r.rotate90ccw().mul(body.angularVelocity)
  );
  const fluidVelocity = getFluidVelocity(point);
  const relativeVelocity = pointVelocity.sub(fluidVelocity);

  const rawSpeed = relativeVelocity.magnitude;
  if (rawSpeed < 0.0001) return;
  const speed = Math.min(rawSpeed, MAX_RELATIVE_SPEED); // Cap for stability
  const velDir = relativeVelocity.normalize();

  const velDotNormal = velDir.dot(edgeNormal);
  const velDotEdge = velDir.dot(edge);

  // Skip if flow is from behind the surface
  if (velDotNormal < 0) return;

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

  // Apply forces: drag opposes motion, lift is perpendicular to flow
  const drag = velDir.mul(-dragMag);
  const lift = velDir.rotate90cw().mul(-liftMag);

  body.applyForce(drag.add(lift), r);
}

// ============================================================================
// Flat Plate Model (for hull, keel, rudder)
// ============================================================================

/**
 * Create a lift magnitude function for flat plate behavior.
 * Lift peaks at 45° angle of attack.
 */
export function flatPlateLift(scale: number): ForceMagnitudeFn {
  return ({ angleOfAttack, speed, edgeLength }) =>
    Math.sin(angleOfAttack) *
    Math.cos(angleOfAttack) *
    speed *
    speed *
    edgeLength *
    scale *
    GLOBAL_FORCE_SCALE;
}

/**
 * Create a drag magnitude function for flat plate behavior.
 * Drag proportional to how face-on the surface is to flow.
 */
export function flatPlateDrag(scale: number): ForceMagnitudeFn {
  return ({ angleOfAttack, speed, edgeLength }) =>
    Math.sin(angleOfAttack) *
    speed *
    speed *
    edgeLength *
    scale *
    GLOBAL_FORCE_SCALE;
}
