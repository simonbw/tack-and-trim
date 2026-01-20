import type { Body } from "../body/Body";
import type { SolverBodyState } from "../solver/GSSolver";
import {
  EQ_B,
  EQ_INV_C,
  EQ_LAMBDA,
  EQ_MAX_FORCE_DT,
  EQ_MIN_FORCE_DT,
} from "../internal";

export interface EquationOptions {
  stiffness?: number;
  relaxation?: number;
}

/** Base class for constraint equations. */
export class Equation {
  static DEFAULT_STIFFNESS = 1e6;
  static DEFAULT_RELAXATION = 4;

  static idCounter = 0;

  id: number;
  minForce: number;
  maxForce: number;
  bodyA: Body;
  bodyB: Body;
  stiffness: number;
  relaxation: number;
  offset: number;
  a: number;
  b: number;
  epsilon: number;
  timeStep: number;
  needsUpdate: boolean;
  multiplier: number;
  relativeVelocity: number;
  enabled: boolean;

  /**
   * Jacobian vector: [vx_A, vy_A, ω_A, vx_B, vy_B, ω_B]
   * Defines what velocities this constraint restricts.
   */
  G: Float32Array = new Float32Array(6);

  // Solver-internal properties (hidden from autocomplete via symbols)
  [EQ_B]: number = 0;
  [EQ_INV_C]: number = 0;
  [EQ_LAMBDA]: number = 0;
  [EQ_MAX_FORCE_DT]: number = 0;
  [EQ_MIN_FORCE_DT]: number = 0;

  constructor(
    bodyA: Body,
    bodyB: Body,
    minForce = -Number.MAX_VALUE,
    maxForce = Number.MAX_VALUE,
  ) {
    this.id = Equation.idCounter++;
    this.minForce = minForce;
    this.maxForce = maxForce;
    this.bodyA = bodyA;
    this.bodyB = bodyB;
    this.stiffness = Equation.DEFAULT_STIFFNESS;
    this.relaxation = Equation.DEFAULT_RELAXATION;
    this.offset = 0;
    this.a = 0;
    this.b = 0;
    this.epsilon = 0;
    this.timeStep = 1 / 60;
    this.needsUpdate = true;
    this.multiplier = 0;
    this.relativeVelocity = 0;
    this.enabled = true;
  }

  update(): this {
    const k = this.stiffness;
    const d = this.relaxation;
    const h = this.timeStep;

    this.a = 4.0 / (h * (1 + 4 * d));
    this.b = (4.0 * d) / (1 + 4 * d);
    this.epsilon = 4.0 / (h * h * k * (1 + 4 * d));
    this.needsUpdate = false;
    return this;
  }

  gmult(
    G: ArrayLike<number>,
    vi: ArrayLike<number>,
    wi: number,
    vj: ArrayLike<number>,
    wj: number,
  ): number {
    return (
      G[0] * vi[0] +
      G[1] * vi[1] +
      G[2] * wi +
      G[3] * vj[0] +
      G[4] * vj[1] +
      G[5] * wj
    );
  }

  computeB(
    a: number,
    b: number,
    h: number,
    bodyState: Map<Body, SolverBodyState>,
  ): number {
    const GW = this.computeGW();
    const Gq = this.computeGq();
    const GiMf = this.computeGiMf(bodyState);
    return -Gq * a - GW * b - GiMf * h;
  }

  computeGq(): number {
    const G = this.G;
    const bi = this.bodyA;
    const bj = this.bodyB;
    const xi = bi.position;
    const xj = bj.position;
    const ai = bi.angle;
    const aj = bj.angle;
    return this.gmult(G, xi, ai, xj, aj) + this.offset;
  }

  computeGW(): number {
    const G = this.G;
    const bi = this.bodyA;
    const bj = this.bodyB;
    const vi = bi.velocity;
    const vj = bj.velocity;
    const wi = bi.angularVelocity;
    const wj = bj.angularVelocity;
    return this.gmult(G, vi, wi, vj, wj) + this.relativeVelocity;
  }

  computeGWlambda(bodyState: Map<Body, SolverBodyState>): number {
    const G = this.G;
    const bi = this.bodyA;
    const bj = this.bodyB;
    const stateI = bodyState.get(bi)!;
    const stateJ = bodyState.get(bj)!;
    return this.gmult(
      G,
      stateI.vlambda,
      stateI.wlambda,
      stateJ.vlambda,
      stateJ.wlambda,
    );
  }

  computeGiMf(bodyState: Map<Body, SolverBodyState>): number {
    const bi = this.bodyA;
    const bj = this.bodyB;
    const fi = bi.force;
    const ti = bi.angularForce;
    const fj = bj.force;
    const tj = bj.angularForce;
    const stateI = bodyState.get(bi)!;
    const stateJ = bodyState.get(bj)!;
    const invMassi = stateI.invMassSolve;
    const invMassj = stateJ.invMassSolve;
    const invIi = stateI.invInertiaSolve;
    const invIj = stateJ.invInertiaSolve;
    const G = this.G;

    return (
      G[0] * fi[0] * invMassi +
      G[1] * fi[1] * invMassi +
      G[2] * ti * invIi +
      G[3] * fj[0] * invMassj +
      G[4] * fj[1] * invMassj +
      G[5] * tj * invIj
    );
  }

  computeGiMGt(bodyState: Map<Body, SolverBodyState>): number {
    const bi = this.bodyA;
    const bj = this.bodyB;
    const stateI = bodyState.get(bi)!;
    const stateJ = bodyState.get(bj)!;
    const invMassi = stateI.invMassSolve;
    const invMassj = stateJ.invMassSolve;
    const invIi = stateI.invInertiaSolve;
    const invIj = stateJ.invInertiaSolve;
    const G = this.G;

    return (
      G[0] * G[0] * invMassi +
      G[1] * G[1] * invMassi +
      G[2] * G[2] * invIi +
      G[3] * G[3] * invMassj +
      G[4] * G[4] * invMassj +
      G[5] * G[5] * invIj
    );
  }

  addToWlambda(
    deltalambda: number,
    bodyState: Map<Body, SolverBodyState>,
  ): this {
    const bi = this.bodyA;
    const bj = this.bodyB;
    const stateI = bodyState.get(bi)!;
    const stateJ = bodyState.get(bj)!;
    const invMassi = stateI.invMassSolve;
    const invMassj = stateJ.invMassSolve;
    const invIi = stateI.invInertiaSolve;
    const invIj = stateJ.invInertiaSolve;
    const G = this.G;

    // v_lambda += inv(M) * delta_lambda * G
    stateI.vlambda[0] += invMassi * G[0] * deltalambda;
    stateI.vlambda[1] += invMassi * G[1] * deltalambda;
    stateI.wlambda += invIi * G[2] * deltalambda;

    stateJ.vlambda[0] += invMassj * G[3] * deltalambda;
    stateJ.vlambda[1] += invMassj * G[4] * deltalambda;
    stateJ.wlambda += invIj * G[5] * deltalambda;
    return this;
  }

  computeInvC(eps: number, bodyState: Map<Body, SolverBodyState>): number {
    return 1.0 / (this.computeGiMGt(bodyState) + eps);
  }
}
