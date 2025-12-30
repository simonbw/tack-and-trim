import { defaults } from "../utils/Utils";
import type Body from "./Body";

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
    const opts = defaults(options, {
      stiffness: 100,
      damping: 1,
    });

    this.stiffness = opts.stiffness;
    this.damping = opts.damping;
    this.bodyA = bodyA;
    this.bodyB = bodyB;
  }

  /**
   * Apply the spring force to the connected bodies.
   */
  applyForce(): void {
    // To be implemented by subclasses
  }
}
