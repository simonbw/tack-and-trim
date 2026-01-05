import type Body from "../body/Body";
import type DynamicBody from "../body/DynamicBody";

export interface SpringOptions {
  stiffness?: number;
  damping?: number;
}

/**
 * A spring, connecting two bodies.
 * At least one body (bodyA) must be dynamic for the spring to have any effect.
 */
export default abstract class Spring {
  stiffness: number;
  damping: number;
  bodyA: DynamicBody;
  bodyB: Body;

  constructor(bodyA: DynamicBody, bodyB: Body, options: SpringOptions = {}) {
    this.stiffness = options?.stiffness ?? 100;
    this.damping = options?.damping ?? 1;
    this.bodyA = bodyA;
    this.bodyB = bodyB;
  }

  /** Apply the spring force to the connected bodies. */
  abstract applyForce(): this;
}
