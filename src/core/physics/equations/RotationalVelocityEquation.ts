import type Body from "../body/Body";
import type { SolverBodyState } from "../solver/GSSolver";
import Equation from "./Equation";

/**
 * Syncs rotational velocity of two bodies, or sets a relative velocity (motor).
 */
export default class RotationalVelocityEquation extends Equation {
  ratio: number = 1;

  constructor(bodyA: Body, bodyB: Body) {
    super(bodyA, bodyB, -Number.MAX_VALUE, Number.MAX_VALUE);
    this.relativeVelocity = 1;
  }

  computeB(
    a: number,
    b: number,
    h: number,
    bodyState: Map<Body, SolverBodyState>,
  ): number {
    const G = this.G;
    G[2] = -1;
    G[5] = this.ratio;

    const GiMf = this.computeGiMf(bodyState);
    const GW = this.computeGW();
    const B = -GW * b - h * GiMf;

    return B;
  }
}
