import type Body from "../body/Body";

export interface SpringOptions {
  stiffness?: number;
  damping?: number;
}

/**
 * A spring, connecting two bodies.
 */
export default class Spring {
  stiffness: number;
  damping: number;
  bodyA: Body;
  bodyB: Body;

  constructor(bodyA: Body, bodyB: Body, options: SpringOptions = {}) {
    this.stiffness = options?.stiffness ?? 100;
    this.damping = options?.damping ?? 1;
    this.bodyA = bodyA;
    this.bodyB = bodyB;
  }

  /**
   * Apply the spring force to the connected bodies.
   */
  applyForce(): this {
    // To be implemented by subclasses
    return this;
  }
}
