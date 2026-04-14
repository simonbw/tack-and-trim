/**
 * Specialized distance constraint equation for two particle-like bodies
 * whose anchors are at the body center (no lever arm) and which never
 * generate rotational impulse.
 *
 * The full 12-component Jacobian of a general distance constraint is:
 *   G = [-n, -(rA × n), n, (rB × n)]
 *
 * For a rope chain link between two particles, both lever arms are zero
 * (the anchor *is* the body center), so the angular blocks vanish and G
 * reduces to:
 *   G_linA = -n,  G_angA = 0
 *   G_linB =  n,  G_angB = 0
 *
 * This class stores only the 3-component direction vector `(nx, ny, nz)`
 * instead of a 12-element Float32Array and overrides every hot solver
 * method (`computeGq`, `computeGW`, `computeGiMf`, `computeGiMGt`) to skip
 * the zero angular terms entirely. The dedicated
 * `iterateParticleDistanceBatch` path in GSSolver further specializes the
 * iteration loop to avoid touching `wlambda` and `invInertia` at all.
 *
 * Typical savings per equation:
 *  - 6 fewer multiply-adds in computeGWlambda (12 → 6)
 *  - 9 fewer multiplies + 6 fewer adds in addToWlambda (angular part gone)
 *  - No 3×3 inverse-inertia matrix dereference per iteration
 *
 * Intended for rope chain links between `RopeParticle` bodies via
 * {@link ParticleDistanceConstraint3D}.
 */
import type { Body } from "../body/Body";
import { EQ_INDEX_A, EQ_INDEX_B } from "../internal";
import type { SolverWorkspace } from "../solver/SolverWorkspace";
import { Equation } from "./Equation";

export class ParticleDistanceEquation3D extends Equation {
  /** Unit direction from bodyA toward bodyB. Refreshed in constraint.update(). */
  nx: number = 0;
  ny: number = 0;
  nz: number = 0;

  /** Current 3D distance between the bodies, cached by constraint.update(). */
  position: number = 0;

  /** Target distance (may be the upperLimit or lowerLimit of the constraint). */
  distance: number = 0;

  constructor(
    bodyA: Body,
    bodyB: Body,
    minForce = -Number.MAX_VALUE,
    maxForce = Number.MAX_VALUE,
  ) {
    super(bodyA, bodyB, minForce, maxForce);
  }

  /**
   * Position error: current distance minus target distance. Signed — positive
   * when the constraint is stretched, negative when compressed.
   */
  override computeGq(): number {
    return this.position - this.distance;
  }

  /**
   * Relative velocity along the constraint direction:
   *   GW = n · (vB - vA) + relativeVelocity
   *
   * Linear only; no angular velocity contribution.
   */
  override computeGW(): number {
    const a = this.bodyA;
    const b = this.bodyB;
    const nx = this.nx;
    const ny = this.ny;
    const nz = this.nz;
    return (
      nx * (b.velocity[0] - a.velocity[0]) +
      ny * (b.velocity[1] - a.velocity[1]) +
      nz * (b.zVelocity - a.zVelocity) +
      this.relativeVelocity
    );
  }

  /**
   * Constraint-velocity from accumulated solver impulses:
   *   GWlambda = n · (vlB - vlA)
   */
  override computeGWlambda(ws: SolverWorkspace): number {
    const iA = this[EQ_INDEX_A] * 3;
    const iB = this[EQ_INDEX_B] * 3;
    const vl = ws.vlambda;
    const nx = this.nx;
    const ny = this.ny;
    const nz = this.nz;
    return (
      nx * (vl[iB] - vl[iA]) +
      ny * (vl[iB + 1] - vl[iA + 1]) +
      nz * (vl[iB + 2] - vl[iA + 2])
    );
  }

  /**
   * External force contribution: G · (M^-1 · f). No angular term.
   *   GiMf = n · (invMB * fB - invMA * fA)  (per-component, with zMass variant)
   */
  override computeGiMf(ws: SolverWorkspace): number {
    const idxA = this[EQ_INDEX_A];
    const idxB = this[EQ_INDEX_B];
    const iMA = ws.invMassSolve[idxA];
    const iMB = ws.invMassSolve[idxB];
    const iMzA = ws.invMassSolveZ[idxA];
    const iMzB = ws.invMassSolveZ[idxB];
    const a = this.bodyA;
    const b = this.bodyB;
    const nx = this.nx;
    const ny = this.ny;
    const nz = this.nz;
    return (
      nx * (b.force[0] * iMB - a.force[0] * iMA) +
      ny * (b.force[1] * iMB - a.force[1] * iMA) +
      nz * (b.zForce * iMzB - a.zForce * iMzA)
    );
  }

  /**
   * Effective-mass denominator: G · M^-1 · G^T. Linear only.
   *   = (nx² + ny²) * (invMA + invMB) + nz² * (invMzA + invMzB)
   *
   * For isotropic bodies (invMA == invMzA) this would reduce further to
   * `invMA + invMB`, but keeping the general form here costs ~3 extra ops
   * and handles mixed-mass bodies correctly.
   */
  override computeGiMGt(ws: SolverWorkspace): number {
    const idxA = this[EQ_INDEX_A];
    const idxB = this[EQ_INDEX_B];
    const iMA = ws.invMassSolve[idxA];
    const iMB = ws.invMassSolve[idxB];
    const iMzA = ws.invMassSolveZ[idxA];
    const iMzB = ws.invMassSolveZ[idxB];
    const nx = this.nx;
    const ny = this.ny;
    const nz = this.nz;
    const nxy2 = nx * nx + ny * ny;
    const nz2 = nz * nz;
    return nxy2 * (iMA + iMB) + nz2 * (iMzA + iMzB);
  }

  /**
   * Apply an impulse delta along the constraint direction. Linear only —
   * never touches wlambda or invInertia.
   */
  override addToWlambda(deltalambda: number, ws: SolverWorkspace): this {
    const idxA = this[EQ_INDEX_A];
    const idxB = this[EQ_INDEX_B];
    const iA = idxA * 3;
    const iB = idxB * 3;
    const vl = ws.vlambda;
    const iMA = ws.invMassSolve[idxA];
    const iMB = ws.invMassSolve[idxB];
    const iMzA = ws.invMassSolveZ[idxA];
    const iMzB = ws.invMassSolveZ[idxB];
    const nx = this.nx;
    const ny = this.ny;
    const nz = this.nz;

    // Body A: vl += invM * (-n) * dl
    vl[iA] -= iMA * nx * deltalambda;
    vl[iA + 1] -= iMA * ny * deltalambda;
    vl[iA + 2] -= iMzA * nz * deltalambda;

    // Body B: vl += invM * (+n) * dl
    vl[iB] += iMB * nx * deltalambda;
    vl[iB + 1] += iMB * ny * deltalambda;
    vl[iB + 2] += iMzB * nz * deltalambda;

    return this;
  }
}
