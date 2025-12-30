import { V2d } from "../../Vector";
import type Body from "../body/Body";
import Equation from "./Equation";

export interface RotationalLockEquationOptions {
  angle?: number;
}

// Module-level temp vectors
const worldVectorA = new V2d(0, 0);
const worldVectorB = new V2d(0, 0);
const xAxis = new V2d(1, 0);
const yAxis = new V2d(0, 1);

/**
 * Locks the relative angle between two bodies. The constraint tries to keep
 * the dot product between two vectors, local in each body, to zero.
 */
export default class RotationalLockEquation extends Equation {
  angle: number;

  constructor(
    bodyA: Body,
    bodyB: Body,
    options: RotationalLockEquationOptions = {}
  ) {
    super(bodyA, bodyB, -Number.MAX_VALUE, Number.MAX_VALUE);

    this.angle = options.angle || 0;

    const G = this.G;
    G[2] = 1;
    G[5] = -1;
  }

  computeGq(): number {
    worldVectorA.set(xAxis).irotate(this.bodyA.angle + this.angle);
    worldVectorB.set(yAxis).irotate(this.bodyB.angle);
    return worldVectorA.dot(worldVectorB);
  }
}
