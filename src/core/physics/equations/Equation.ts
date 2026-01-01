import type Body from "../body/Body";

export interface EquationOptions {
  stiffness?: number;
  relaxation?: number;
}

/** Base class for constraint equations. */
export default class Equation {
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
  G: Float32Array;
  offset: number;
  a: number;
  b: number;
  epsilon: number;
  timeStep: number;
  needsUpdate: boolean;
  multiplier: number;
  relativeVelocity: number;
  enabled: boolean;

  // Pre-computed values for solver optimization (set during solve)
  B: number = 0;
  invC: number = 0;
  lambda: number = 0;
  maxForceDt: number = 0;
  minForceDt: number = 0;

  constructor(
    bodyA: Body,
    bodyB: Body,
    minForce = -Number.MAX_VALUE,
    maxForce = Number.MAX_VALUE
  ) {
    this.id = Equation.idCounter++;
    this.minForce = minForce;
    this.maxForce = maxForce;
    this.bodyA = bodyA;
    this.bodyB = bodyB;
    this.stiffness = Equation.DEFAULT_STIFFNESS;
    this.relaxation = Equation.DEFAULT_RELAXATION;
    this.G = new Float32Array(6);
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
    wj: number
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

  computeB(a: number, b: number, h: number): number {
    const GW = this.computeGW();
    const Gq = this.computeGq();
    const GiMf = this.computeGiMf();
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

  computeGWlambda(): number {
    const G = this.G;
    const bi = this.bodyA;
    const bj = this.bodyB;
    const vi = bi.vlambda;
    const vj = bj.vlambda;
    const wi = bi.wlambda;
    const wj = bj.wlambda;
    return this.gmult(G, vi, wi, vj, wj);
  }

  computeGiMf(): number {
    const bi = this.bodyA;
    const bj = this.bodyB;
    const fi = bi.force;
    const ti = bi.angularForce;
    const fj = bj.force;
    const tj = bj.angularForce;
    const invMassi = bi.invMassSolve;
    const invMassj = bj.invMassSolve;
    const invIi = bi.invInertiaSolve;
    const invIj = bj.invInertiaSolve;
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

  computeGiMGt(): number {
    const bi = this.bodyA;
    const bj = this.bodyB;
    const invMassi = bi.invMassSolve;
    const invMassj = bj.invMassSolve;
    const invIi = bi.invInertiaSolve;
    const invIj = bj.invInertiaSolve;
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

  addToWlambda(deltalambda: number): this {
    const bi = this.bodyA;
    const bj = this.bodyB;
    const invMassi = bi.invMassSolve;
    const invMassj = bj.invMassSolve;
    const invIi = bi.invInertiaSolve;
    const invIj = bj.invInertiaSolve;
    const G = this.G;

    // v_lambda += inv(M) * delta_lambda * G
    bi.vlambda[0] += invMassi * G[0] * deltalambda;
    bi.vlambda[1] += invMassi * G[1] * deltalambda;
    bi.wlambda += invIi * G[2] * deltalambda;

    bj.vlambda[0] += invMassj * G[3] * deltalambda;
    bj.vlambda[1] += invMassj * G[4] * deltalambda;
    bj.wlambda += invIj * G[5] * deltalambda;
    return this;
  }

  computeInvC(eps: number): number {
    return 1.0 / (this.computeGiMGt() + eps);
  }
}
