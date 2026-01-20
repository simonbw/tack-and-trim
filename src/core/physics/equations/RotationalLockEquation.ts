import { V, V2d } from "../../Vector";
import type { Body } from "../body/Body";
import { Equation } from "./Equation";

export interface RotationalLockEquationOptions {
  angle?: number;
}

/**
 * Locks the relative angle between two bodies. The constraint tries to keep
 * the dot product between two vectors, local in each body, to zero.
 */
export class RotationalLockEquation extends Equation {
  angle: number;

  constructor(
    bodyA: Body,
    bodyB: Body,
    options: RotationalLockEquationOptions = {},
  ) {
    super(bodyA, bodyB, -Number.MAX_VALUE, Number.MAX_VALUE);

    this.angle = options.angle || 0;

    const G = this.G;
    G[2] = 1;
    G[5] = -1;
  }

  computeGq(): number {
    const worldVectorA = V(1, 0).irotate(this.bodyA.angle + this.angle);
    const worldVectorB = V(0, 1).irotate(this.bodyB.angle);
    return worldVectorA.dot(worldVectorB);
  }
}
