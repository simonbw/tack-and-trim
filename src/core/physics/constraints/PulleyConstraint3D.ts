/**
 * 3-body pulley constraint with optional ratchet.
 *
 * Enforces: |anchorA - pulleyAnchor| + |pulleyAnchor - anchorB| ≤ totalLength
 *
 * Models a rope passing through a block/pulley. The solver naturally
 * distributes rope length between the two sides and applies the correct
 * force redirection to the pulley body.
 *
 * ## Modes
 *
 * - **free**: rope slides freely through the pulley (default for blocks).
 * - **ratchet**: rope can slide from A→pulley (distA decreasing, i.e.
 *   trimming in) but not the reverse. Models a cam cleat or self-tailing
 *   winch — the working side can get shorter but not longer.
 *
 * bodyA and bodyB are the two rope particles that straddle the pulley.
 * bodyC is the body the pulley is mounted on (typically the hull).
 * As the rope slides through, call setParticleA/B to update which
 * particles the constraint references.
 */

import type { Body } from "../body/Body";
import { DynamicBody } from "../body/DynamicBody";
import { Equation } from "../equations/Equation";
import { PulleyEquation } from "../equations/PulleyEquation";
import { Constraint, ConstraintOptions } from "./Constraint";

export type PulleyMode = "free" | "ratchet";

export interface PulleyConstraint3DOptions extends ConstraintOptions {
  /** Anchor on bodyA in local coordinates. Default [0,0,0]. */
  localAnchorA?: [number, number, number];
  /** Anchor on bodyB in local coordinates. Default [0,0,0]. */
  localAnchorB?: [number, number, number];
  /** Anchor on the pulley body (bodyC) in local coordinates. */
  localAnchorC?: [number, number, number];
  /** Max total rope length through the pulley. If omitted, uses current distance. */
  totalLength?: number;
  /** Max constraint force. Default MAX_VALUE. */
  maxForce?: number;
}

export class PulleyConstraint3D extends Constraint {
  /** The pulley/block body. */
  bodyC: Body;

  localAnchorA: [number, number, number];
  localAnchorB: [number, number, number];
  localAnchorC: [number, number, number];

  /** Upper limit: max combined path distance through pulley. */
  totalLength: number;
  /** Enable/disable the upper limit. */
  upperLimitEnabled: boolean = true;
  /** Max force magnitude. */
  maxForce: number;

  /** Current distance from bodyA anchor to pulley anchor. */
  distA: number = 0;
  /** Current distance from pulley anchor to bodyB anchor. */
  distB: number = 0;
  /** Current total path distance (distA + distB). */
  position: number = 0;

  /** Pulley mode: "free" (rope slides both ways) or "ratchet" (A side can only shorten). */
  mode: PulleyMode = "free";
  /** When ratcheting, the maximum allowed distA. Tracked downward as rope slides in. */
  ratchetDistA: number = Infinity;

  /**
   * Coulomb friction coefficient for rope sliding through this pulley.
   * 0 = frictionless block. Typical values: 0.05–0.3 for well-maintained
   * blocks, up to 1+ for a fairlead or jammed sheave.
   */
  frictionCoefficient: number = 0;

  private sumEquation: PulleyEquation;
  /**
   * Ratchet equation: a 2-body distance upper-limit between bodyA (particle)
   * and bodyC (pulley body). Prevents distA from exceeding ratchetDistA.
   * Only enabled in ratchet mode.
   */
  private ratchetEquation: Equation;
  /**
   * Friction equation: bilateral velocity constraint that resists rope sliding
   * through the pulley. Force bounds are ±frictionCoefficient * tension,
   * giving Coulomb stick/slip behaviour. Only enabled when frictionCoefficient > 0
   * and the rope is taut.
   */
  private frictionEquation: Equation;

  constructor(
    bodyA: Body,
    bodyB: Body,
    bodyC: Body,
    options: PulleyConstraint3DOptions = {},
  ) {
    super(bodyA, bodyB, options);
    this.bodyC = bodyC;

    // Wake bodyC too
    if ((options.wakeUpBodies ?? true) && bodyC instanceof DynamicBody) {
      bodyC.wakeUp();
    }

    this.localAnchorA = options.localAnchorA
      ? [...options.localAnchorA]
      : [0, 0, 0];
    this.localAnchorB = options.localAnchorB
      ? [...options.localAnchorB]
      : [0, 0, 0];
    this.localAnchorC = options.localAnchorC
      ? [...options.localAnchorC]
      : [0, 0, 0];

    this.maxForce = options.maxForce ?? Number.MAX_VALUE;

    // Compute initial total length if not provided
    if (typeof options.totalLength === "number") {
      this.totalLength = options.totalLength;
    } else {
      const [ax, ay, az] = bodyA.toWorldFrame3D(...this.localAnchorA);
      const [px, py, pz] = bodyC.toWorldFrame3D(...this.localAnchorC);
      const [bx, by, bz] = bodyB.toWorldFrame3D(...this.localAnchorB);
      const dAx = ax - px,
        dAy = ay - py,
        dAz = az - pz;
      const dBx = bx - px,
        dBy = by - py,
        dBz = bz - pz;
      this.totalLength =
        Math.sqrt(dAx * dAx + dAy * dAy + dAz * dAz) +
        Math.sqrt(dBx * dBx + dBy * dBy + dBz * dBz);
    }

    // Sum equation: 3-body, constrains total path length
    this.sumEquation = new PulleyEquation(bodyA, bodyB, bodyC);
    this.sumEquation.maxForce = 0;
    this.sumEquation.minForce = -this.maxForce;

    const self = this;
    this.sumEquation.computeGq = function () {
      return self.position - self.totalLength;
    };

    // Ratchet equation: 2-body (bodyA ↔ bodyC), constrains distA
    this.ratchetEquation = new Equation(bodyA, bodyC);
    this.ratchetEquation.maxForce = 0;
    this.ratchetEquation.minForce = -this.maxForce;
    this.ratchetEquation.enabled = false;

    this.ratchetEquation.computeGq = function () {
      return self.distA - self.ratchetDistA;
    };

    // Friction equation: resists rope sliding through pulley (bilateral)
    this.frictionEquation = new Equation(bodyA, bodyC);
    this.frictionEquation.maxForce = 0;
    this.frictionEquation.minForce = 0;
    this.frictionEquation.enabled = false;
    this.frictionEquation.computeGq = () => 0;

    this.equations = [
      this.sumEquation,
      this.ratchetEquation,
      this.frictionEquation,
    ];
  }

  /**
   * Update which particle is on side A of the pulley.
   *
   * @param ratchetDelta If provided, shift `ratchetDistA` by this amount
   *   instead of resetting. Use this when swapping to a neighbor particle
   *   along a rope chain: passing the chain-length distance between the
   *   old and new particles preserves the ratchet's working-length lock
   *   across the swap (no momentary slack). If omitted, the ratchet
   *   resets to Infinity and re-locks on the next update.
   */
  setParticleA(
    body: Body,
    localAnchor: [number, number, number],
    ratchetDelta?: number,
  ): void {
    this.bodyA = body;
    this.sumEquation.bodyA = body;
    this.ratchetEquation.bodyA = body;
    this.frictionEquation.bodyA = body;
    this.localAnchorA = localAnchor;
    if (this.mode === "ratchet") {
      if (ratchetDelta !== undefined && Number.isFinite(this.ratchetDistA)) {
        this.ratchetDistA = Math.max(0, this.ratchetDistA + ratchetDelta);
      } else {
        this.ratchetDistA = Infinity;
      }
    }
  }

  /** Update which particle is on side B of the pulley. */
  setParticleB(body: Body, localAnchor: [number, number, number]): void {
    this.bodyB = body;
    this.sumEquation.bodyB = body;
    this.localAnchorB = localAnchor;
  }

  /**
   * Set the pulley mode.
   * - "free": rope slides both directions (block, or easing)
   * - "ratchet": A side can only get shorter (cam cleat / winch idle+trim)
   *
   * On transition to ratchet, the lock is deferred: ratchetDistA is set to
   * Infinity so the next update() tracks it down to the true current distA.
   * This avoids capturing a stale this.distA (which may be 0 if setMode is
   * called before any update() has run — e.g. at construction).
   */
  setMode(mode: PulleyMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === "ratchet") {
      this.ratchetDistA = Infinity;
    }
  }

  update(): this {
    const eq = this.sumEquation;

    // Transform local anchors to world 3D
    const [ax, ay, az] = this.bodyA.toWorldFrame3D(...this.localAnchorA);
    const [px, py, pz] = this.bodyC.toWorldFrame3D(...this.localAnchorC);
    const [bx, by, bz] = this.bodyB.toWorldFrame3D(...this.localAnchorB);

    // Separation vectors and distances
    const dAx = ax - px,
      dAy = ay - py,
      dAz = az - pz;
    const dBx = bx - px,
      dBy = by - py,
      dBz = bz - pz;
    this.distA = Math.sqrt(dAx * dAx + dAy * dAy + dAz * dAz);
    this.distB = Math.sqrt(dBx * dBx + dBy * dBy + dBz * dBz);
    this.position = this.distA + this.distB;

    // --- Sum equation (total path length) ---

    if (this.upperLimitEnabled && this.position <= this.totalLength) {
      eq.enabled = false;
    } else {
      eq.enabled = true;
      eq.maxForce = 0;
      eq.minForce = -this.maxForce;
    }

    // Normalized directions from pulley toward each particle
    let nAx: number, nAy: number, nAz: number;
    if (this.distA > 0.0001) {
      const inv = 1 / this.distA;
      nAx = dAx * inv;
      nAy = dAy * inv;
      nAz = dAz * inv;
    } else {
      nAx = 1;
      nAy = 0;
      nAz = 0;
    }

    let nBx: number, nBy: number, nBz: number;
    if (this.distB > 0.0001) {
      const inv = 1 / this.distB;
      nBx = dBx * inv;
      nBy = dBy * inv;
      nBz = dBz * inv;
    } else {
      nBx = -1;
      nBy = 0;
      nBz = 0;
    }

    // Lever arms from body centers to world anchor points
    const [paX, paY] = this.bodyA.position;
    const rAx = ax - paX,
      rAy = ay - paY,
      rAz = az - this.bodyA.z;

    const [pcX, pcY] = this.bodyC.position;
    const rCx = px - pcX,
      rCy = py - pcY,
      rCz = pz - this.bodyC.z;

    const [pbX, pbY] = this.bodyB.position;
    const rBx = bx - pbX,
      rBy = by - pbY,
      rBz = bz - this.bodyB.z;

    // Fill the 18-element sum Jacobian
    if (eq.enabled) {
      eq.setJacobian(
        nAx,
        nAy,
        nAz,
        nBx,
        nBy,
        nBz,
        rAx,
        rAy,
        rAz,
        rCx,
        rCy,
        rCz,
        rBx,
        rBy,
        rBz,
      );
    }

    // --- Ratchet equation (distA upper limit) ---

    if (this.mode === "ratchet") {
      // Track distA downward — allow trimming in but not easing out
      if (this.distA < this.ratchetDistA) {
        this.ratchetDistA = this.distA;
      }

      if (this.distA <= this.ratchetDistA) {
        // Constraint satisfied — disable to avoid unnecessary solver work
        this.ratchetEquation.enabled = false;
      } else {
        this.ratchetEquation.enabled = true;
        this.ratchetEquation.maxForce = 0;
        this.ratchetEquation.minForce = -this.maxForce;

        // Fill 12-element Jacobian for distance(A, C) upper limit
        // bodyA of ratchetEquation = particle, bodyB of ratchetEquation = pulley body
        const G = this.ratchetEquation.G;
        // Particle (bodyA): force along nA (away from pulley)
        G[0] = nAx;
        G[1] = nAy;
        G[2] = nAz;
        // Particle angular: rA × nA
        G[3] = rAy * nAz - rAz * nAy;
        G[4] = rAz * nAx - rAx * nAz;
        G[5] = rAx * nAy - rAy * nAx;
        // Pulley body (bodyB): force along -nA (toward particle)
        G[6] = -nAx;
        G[7] = -nAy;
        G[8] = -nAz;
        // Pulley angular: rC × (-nA)
        G[9] = -(rCy * nAz - rCz * nAy);
        G[10] = -(rCz * nAx - rCx * nAz);
        G[11] = -(rCx * nAy - rCy * nAx);
      }
    } else {
      this.ratchetEquation.enabled = false;
    }

    // --- Friction equation ---
    if (this.frictionCoefficient > 0 && eq.enabled) {
      const slip =
        Math.abs(this.sumEquation.multiplier) * this.frictionCoefficient;
      this.frictionEquation.enabled = true;
      this.frictionEquation.maxForce = slip;
      this.frictionEquation.minForce = -slip;

      // Same Jacobian as ratchet: constrains d(distA)/dt = 0
      const Gf = this.frictionEquation.G;
      Gf[0] = nAx;
      Gf[1] = nAy;
      Gf[2] = nAz;
      Gf[3] = rAy * nAz - rAz * nAy;
      Gf[4] = rAz * nAx - rAx * nAz;
      Gf[5] = rAx * nAy - rAy * nAx;
      Gf[6] = -nAx;
      Gf[7] = -nAy;
      Gf[8] = -nAz;
      Gf[9] = -(rCy * nAz - rCz * nAy);
      Gf[10] = -(rCz * nAx - rCx * nAz);
      Gf[11] = -(rCx * nAy - rCy * nAx);
    } else {
      this.frictionEquation.enabled = false;
    }

    return this;
  }

  /** Set the max force to be used. */
  setMaxForce(maxForce: number): void {
    this.maxForce = maxForce;
    this.sumEquation.minForce = -maxForce;
    this.ratchetEquation.minForce = -maxForce;
  }
}
