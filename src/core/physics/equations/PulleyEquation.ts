/**
 * 3-body constraint equation for a pulley/block.
 *
 * Enforces: |rA - rP| + |rP - rB| ≤ totalLength
 *
 * Where rA, rP, rB are the world-space anchor positions on bodyA (particle),
 * bodyC (pulley/block body), and bodyB (particle) respectively.
 *
 * The Jacobian has 18 elements (6 per body × 3 bodies) instead of the
 * base class's 12. All compute/apply methods are overridden to include
 * bodyC's contributions. The GSSolver only calls virtual methods, so
 * this slots into the existing solver without modification.
 */

import type { Body } from "../body/Body";
import type { SolverBodyState } from "../solver/GSSolver";
import { Equation } from "./Equation";

export class PulleyEquation extends Equation {
  /** The third body (pulley/block body). */
  bodyC: Body;

  /**
   * Extended Jacobian: 18 elements.
   * [bodyA linear(3), bodyA angular(3),
   *  bodyC linear(3), bodyC angular(3),
   *  bodyB linear(3), bodyB angular(3)]
   */
  private G18 = new Float64Array(18);

  constructor(bodyA: Body, bodyB: Body, bodyC: Body) {
    super(bodyA, bodyB);
    this.bodyC = bodyC;
  }

  /**
   * Fill the 18-element Jacobian from pre-computed directions and lever arms.
   * Called by PulleyConstraint3D.update().
   */
  setJacobian(
    // Unit direction from pulley toward A
    nAx: number,
    nAy: number,
    nAz: number,
    // Unit direction from pulley toward B
    nBx: number,
    nBy: number,
    nBz: number,
    // Lever arm: world anchor A minus bodyA center
    rAx: number,
    rAy: number,
    rAz: number,
    // Lever arm: world pulley anchor minus bodyC center
    rCx: number,
    rCy: number,
    rCz: number,
    // Lever arm: world anchor B minus bodyB center
    rBx: number,
    rBy: number,
    rBz: number,
  ): void {
    const G = this.G18;

    // Body A: pulled toward pulley → force direction = nA
    G[0] = nAx;
    G[1] = nAy;
    G[2] = nAz;
    // Body A angular: rA × nA
    G[3] = rAy * nAz - rAz * nAy;
    G[4] = rAz * nAx - rAx * nAz;
    G[5] = rAx * nAy - rAy * nAx;

    // Body C (pulley): receives resultant = -nA - nB
    const cLx = -nAx - nBx;
    const cLy = -nAy - nBy;
    const cLz = -nAz - nBz;
    G[6] = cLx;
    G[7] = cLy;
    G[8] = cLz;
    // Body C angular: rC × (-nA - nB)
    G[9] = rCy * cLz - rCz * cLy;
    G[10] = rCz * cLx - rCx * cLz;
    G[11] = rCx * cLy - rCy * cLx;

    // Body B: pulled toward pulley → force direction = nB
    G[12] = nBx;
    G[13] = nBy;
    G[14] = nBz;
    // Body B angular: rB × nB
    G[15] = rBy * nBz - rBz * nBy;
    G[16] = rBz * nBx - rBx * nBz;
    G[17] = rBx * nBy - rBy * nBx;
  }

  // ---- Override all virtual methods to use G18 and 3 bodies ----

  override computeGW(): number {
    const G = this.G18;
    const a = this.bodyA;
    const c = this.bodyC;
    const b = this.bodyB;
    const wA = a.angularVelocity3;
    const wC = c.angularVelocity3;
    const wB = b.angularVelocity3;
    return (
      G[0] * a.velocity[0] +
      G[1] * a.velocity[1] +
      G[2] * a.zVelocity +
      G[3] * wA[0] +
      G[4] * wA[1] +
      G[5] * wA[2] +
      G[6] * c.velocity[0] +
      G[7] * c.velocity[1] +
      G[8] * c.zVelocity +
      G[9] * wC[0] +
      G[10] * wC[1] +
      G[11] * wC[2] +
      G[12] * b.velocity[0] +
      G[13] * b.velocity[1] +
      G[14] * b.zVelocity +
      G[15] * wB[0] +
      G[16] * wB[1] +
      G[17] * wB[2] +
      this.relativeVelocity
    );
  }

  override computeGWlambda(bodyState: Map<Body, SolverBodyState>): number {
    const G = this.G18;
    const sA = bodyState.get(this.bodyA)!;
    const sC = bodyState.get(this.bodyC)!;
    const sB = bodyState.get(this.bodyB)!;
    return (
      G[0] * sA.vlambda[0] +
      G[1] * sA.vlambda[1] +
      G[2] * sA.vlambda[2] +
      G[3] * sA.wlambda[0] +
      G[4] * sA.wlambda[1] +
      G[5] * sA.wlambda[2] +
      G[6] * sC.vlambda[0] +
      G[7] * sC.vlambda[1] +
      G[8] * sC.vlambda[2] +
      G[9] * sC.wlambda[0] +
      G[10] * sC.wlambda[1] +
      G[11] * sC.wlambda[2] +
      G[12] * sB.vlambda[0] +
      G[13] * sB.vlambda[1] +
      G[14] * sB.vlambda[2] +
      G[15] * sB.wlambda[0] +
      G[16] * sB.wlambda[1] +
      G[17] * sB.wlambda[2]
    );
  }

  override computeGiMf(bodyState: Map<Body, SolverBodyState>): number {
    const G = this.G18;
    const a = this.bodyA;
    const c = this.bodyC;
    const b = this.bodyB;
    const sA = bodyState.get(a)!;
    const sC = bodyState.get(c)!;
    const sB = bodyState.get(b)!;

    // Body A: invI_world * torque3
    const iIA = sA.invInertiaSolve;
    const tA = a.angularForce3;
    const aA0 = iIA[0] * tA[0] + iIA[1] * tA[1] + iIA[2] * tA[2];
    const aA1 = iIA[3] * tA[0] + iIA[4] * tA[1] + iIA[5] * tA[2];
    const aA2 = iIA[6] * tA[0] + iIA[7] * tA[1] + iIA[8] * tA[2];

    // Body C: invI_world * torque3
    const iIC = sC.invInertiaSolve;
    const tC = c.angularForce3;
    const aC0 = iIC[0] * tC[0] + iIC[1] * tC[1] + iIC[2] * tC[2];
    const aC1 = iIC[3] * tC[0] + iIC[4] * tC[1] + iIC[5] * tC[2];
    const aC2 = iIC[6] * tC[0] + iIC[7] * tC[1] + iIC[8] * tC[2];

    // Body B: invI_world * torque3
    const iIB = sB.invInertiaSolve;
    const tB = b.angularForce3;
    const aB0 = iIB[0] * tB[0] + iIB[1] * tB[1] + iIB[2] * tB[2];
    const aB1 = iIB[3] * tB[0] + iIB[4] * tB[1] + iIB[5] * tB[2];
    const aB2 = iIB[6] * tB[0] + iIB[7] * tB[1] + iIB[8] * tB[2];

    return (
      G[0] * a.force[0] * sA.invMassSolve +
      G[1] * a.force[1] * sA.invMassSolve +
      G[2] * a.zForce * sA.invMassSolveZ +
      G[3] * aA0 +
      G[4] * aA1 +
      G[5] * aA2 +
      G[6] * c.force[0] * sC.invMassSolve +
      G[7] * c.force[1] * sC.invMassSolve +
      G[8] * c.zForce * sC.invMassSolveZ +
      G[9] * aC0 +
      G[10] * aC1 +
      G[11] * aC2 +
      G[12] * b.force[0] * sB.invMassSolve +
      G[13] * b.force[1] * sB.invMassSolve +
      G[14] * b.zForce * sB.invMassSolveZ +
      G[15] * aB0 +
      G[16] * aB1 +
      G[17] * aB2
    );
  }

  override computeGiMGt(bodyState: Map<Body, SolverBodyState>): number {
    const G = this.G18;
    const sA = bodyState.get(this.bodyA)!;
    const sC = bodyState.get(this.bodyC)!;
    const sB = bodyState.get(this.bodyB)!;

    // Body A linear
    let result =
      G[0] * G[0] * sA.invMassSolve +
      G[1] * G[1] * sA.invMassSolve +
      G[2] * G[2] * sA.invMassSolveZ;
    // Body A angular: G_ang^T * invI * G_ang
    const iIA = sA.invInertiaSolve;
    result +=
      G[3] * (iIA[0] * G[3] + iIA[1] * G[4] + iIA[2] * G[5]) +
      G[4] * (iIA[3] * G[3] + iIA[4] * G[4] + iIA[5] * G[5]) +
      G[5] * (iIA[6] * G[3] + iIA[7] * G[4] + iIA[8] * G[5]);

    // Body C linear
    result +=
      G[6] * G[6] * sC.invMassSolve +
      G[7] * G[7] * sC.invMassSolve +
      G[8] * G[8] * sC.invMassSolveZ;
    // Body C angular
    const iIC = sC.invInertiaSolve;
    result +=
      G[9] * (iIC[0] * G[9] + iIC[1] * G[10] + iIC[2] * G[11]) +
      G[10] * (iIC[3] * G[9] + iIC[4] * G[10] + iIC[5] * G[11]) +
      G[11] * (iIC[6] * G[9] + iIC[7] * G[10] + iIC[8] * G[11]);

    // Body B linear
    result +=
      G[12] * G[12] * sB.invMassSolve +
      G[13] * G[13] * sB.invMassSolve +
      G[14] * G[14] * sB.invMassSolveZ;
    // Body B angular
    const iIB = sB.invInertiaSolve;
    result +=
      G[15] * (iIB[0] * G[15] + iIB[1] * G[16] + iIB[2] * G[17]) +
      G[16] * (iIB[3] * G[15] + iIB[4] * G[16] + iIB[5] * G[17]) +
      G[17] * (iIB[6] * G[15] + iIB[7] * G[16] + iIB[8] * G[17]);

    return result;
  }

  override addToWlambda(
    deltalambda: number,
    bodyState: Map<Body, SolverBodyState>,
  ): this {
    const G = this.G18;
    const dl = deltalambda;
    const sA = bodyState.get(this.bodyA)!;
    const sC = bodyState.get(this.bodyC)!;
    const sB = bodyState.get(this.bodyB)!;

    // Body A linear
    sA.vlambda[0] += sA.invMassSolve * G[0] * dl;
    sA.vlambda[1] += sA.invMassSolve * G[1] * dl;
    sA.vlambda[2] += sA.invMassSolveZ * G[2] * dl;
    // Body A angular
    const iIA = sA.invInertiaSolve;
    const gA3 = G[3] * dl;
    const gA4 = G[4] * dl;
    const gA5 = G[5] * dl;
    sA.wlambda[0] += iIA[0] * gA3 + iIA[1] * gA4 + iIA[2] * gA5;
    sA.wlambda[1] += iIA[3] * gA3 + iIA[4] * gA4 + iIA[5] * gA5;
    sA.wlambda[2] += iIA[6] * gA3 + iIA[7] * gA4 + iIA[8] * gA5;

    // Body C linear
    sC.vlambda[0] += sC.invMassSolve * G[6] * dl;
    sC.vlambda[1] += sC.invMassSolve * G[7] * dl;
    sC.vlambda[2] += sC.invMassSolveZ * G[8] * dl;
    // Body C angular
    const iIC = sC.invInertiaSolve;
    const gC9 = G[9] * dl;
    const gC10 = G[10] * dl;
    const gC11 = G[11] * dl;
    sC.wlambda[0] += iIC[0] * gC9 + iIC[1] * gC10 + iIC[2] * gC11;
    sC.wlambda[1] += iIC[3] * gC9 + iIC[4] * gC10 + iIC[5] * gC11;
    sC.wlambda[2] += iIC[6] * gC9 + iIC[7] * gC10 + iIC[8] * gC11;

    // Body B linear
    sB.vlambda[0] += sB.invMassSolve * G[12] * dl;
    sB.vlambda[1] += sB.invMassSolve * G[13] * dl;
    sB.vlambda[2] += sB.invMassSolveZ * G[14] * dl;
    // Body B angular
    const iIB = sB.invInertiaSolve;
    const gB15 = G[15] * dl;
    const gB16 = G[16] * dl;
    const gB17 = G[17] * dl;
    sB.wlambda[0] += iIB[0] * gB15 + iIB[1] * gB16 + iIB[2] * gB17;
    sB.wlambda[1] += iIB[3] * gB15 + iIB[4] * gB16 + iIB[5] * gB17;
    sB.wlambda[2] += iIB[6] * gB15 + iIB[7] * gB16 + iIB[8] * gB17;

    return this;
  }
}
