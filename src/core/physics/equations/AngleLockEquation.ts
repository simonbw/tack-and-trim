import type { Body } from "../body/Body";
import { Equation } from "./Equation";

export interface AngleLockEquationOptions {
  angle?: number;
  ratio?: number;
}

/**
 * Locks the relative angle between two bodies. The constraint tries to keep
 * the dot product between two vectors, local in each body, to zero.
 */
export class AngleLockEquation extends Equation {
  angle: number;

  /**
   * The gear ratio.
   */
  ratio: number;

  constructor(
    bodyA: Body,
    bodyB: Body,
    options: AngleLockEquationOptions = {},
  ) {
    super(bodyA, bodyB, -Number.MAX_VALUE, Number.MAX_VALUE);
    this.angle = options.angle || 0;
    this.ratio = typeof options.ratio === "number" ? options.ratio : 1;
    this.setRatio(this.ratio);
  }

  computeGq(): number {
    return this.ratio * this.bodyA.angle - this.bodyB.angle + this.angle;
  }

  /**
   * Set the gear ratio for this equation
   */
  setRatio(ratio: number): void {
    const G = this.G;
    G[2] = ratio;
    G[5] = -1;
    this.ratio = ratio;
  }

  /**
   * Set the max force for the equation.
   */
  setMaxTorque(torque: number): void {
    this.maxForce = torque;
    this.minForce = -torque;
  }
}
