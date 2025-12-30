import Equation from "./Equation";
import vec2 from "../math/vec2";
import type Body from "../objects/Body";

export interface RotationalLockEquationOptions {
  angle?: number;
}

// Module-level temp vectors
const worldVectorA = vec2.create();
const worldVectorB = vec2.create();
const xAxis = vec2.fromValues(1, 0);
const yAxis = vec2.fromValues(0, 1);

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
    vec2.rotate(worldVectorA, xAxis, this.bodyA.angle + this.angle);
    vec2.rotate(worldVectorB, yAxis, this.bodyB.angle);
    return vec2.dot(worldVectorA, worldVectorB);
  }
}
