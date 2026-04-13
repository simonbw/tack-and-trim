import type { Body } from "../body/Body";
import type { SolverWorkspace } from "../solver/SolverWorkspace";
import { Equation } from "./Equation";

/**
 * Syncs rotational velocity of two bodies, or sets a relative velocity (motor).
 */
export class RotationalVelocityEquation extends Equation {
  ratio: number = 1;

  constructor(bodyA: Body, bodyB: Body) {
    super(bodyA, bodyB, -Number.MAX_VALUE, Number.MAX_VALUE);
    this.relativeVelocity = 1;
  }

  computeB(a: number, b: number, h: number, ws: SolverWorkspace): number {
    const G = this.G;
    G[5] = -1;
    G[11] = this.ratio;

    const GiMf = this.computeGiMf(ws);
    const GW = this.computeGW();
    const B = -GW * b - h * GiMf;

    return B;
  }
}
