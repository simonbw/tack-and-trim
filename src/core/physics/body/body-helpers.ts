import { Particle } from "../shapes/Particle";
import { Body } from "./Body";

/**
 * Returns true if the body's shape composition is entirely Particle shapes.
 * Useful because particle-shape vs particle-shape has no narrowphase handler,
 * so such bodies can skip pairwise collision registration with each other.
 *
 * Note: this is a shape-composition check, distinct from the body-level
 * PointMass DOF concept.
 */
export function hasOnlyParticleShapes(body: Body): boolean {
  return (
    body.shapes.length > 0 && body.shapes.every((s) => s instanceof Particle)
  );
}

/** True if the body is a dynamic body that is currently awake. */
export function isAwake(body: Body): boolean {
  return body.motion === "dynamic" && !body.isSleeping();
}
