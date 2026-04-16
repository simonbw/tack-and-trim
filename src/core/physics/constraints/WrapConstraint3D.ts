/**
 * 3-body rope "wrap" constraint for hull crossings.
 *
 * Models the situation where two adjacent rope particles end up on opposite
 * sides of an infinitely-thin hull wall — typically because the boat moved
 * and swept its hull past a stationary rope particle. The straight-line
 * chain constraint between those two particles "cuts the corner" through
 * the wall: the chord is shorter than the over-the-edge path, so the chain
 * constraint sees slack that isn't really there and no tension transmits.
 *
 * This constraint sits *alongside* the regular chain distance constraint,
 * adding the strictly tighter upper-limit
 *
 *     |A − peg| + |peg − B| ≤ totalLength
 *
 * only while a hull straddle is detected. The peg is recomputed each
 * substep from the chord's intersection with the deck-level hull outline;
 * it slides along the gunwale as the rope and hull move.
 *
 * Shape-wise this is the same as {@link PulleyConstraint3D} — a single
 * {@link PulleyEquation} with an 18-component Jacobian. The differences are
 * that (1) the "pulley anchor" on bodyC is recomputed each substep instead
 * of being a fixed `localAnchorC`, (2) there is no ratchet or friction sub-
 * equation (first pass), and (3) the equation is disabled as soon as the
 * particles are back on the same side of the hull.
 */

import type { Body } from "../body/Body";
import { DynamicBody } from "../body/DynamicBody";
import { PulleyEquation } from "../equations/PulleyEquation";
import { findChordHullCrossing } from "../utils/HullBoundaryGeometry";
import { Constraint, type ConstraintOptions } from "./Constraint";
import type {
  DeckContactConstraint,
  HullBoundaryData,
} from "./DeckContactConstraint";

export interface WrapConstraint3DOptions extends ConstraintOptions {
  /** Max constraint force. Default MAX_VALUE. */
  maxForce?: number;
}

export class WrapConstraint3D extends Constraint {
  /** The hull body the rope is wrapping around (bodyC in PulleyEquation). */
  readonly hullBody: Body;

  /** Chain link length — the over-the-peg path may not exceed this. */
  totalLength: number;

  /** Max force magnitude (upper-limit only, so minForce = -maxForce). */
  maxForce: number;

  /** Current distance from particle A to the peg. */
  distA: number = 0;
  /** Current distance from the peg to particle B. */
  distB: number = 0;
  /** Current total path distance (distA + distB). */
  position: number = 0;

  private readonly sumEquation: PulleyEquation;
  private readonly hullBoundary: HullBoundaryData;
  private readonly deckContactA: DeckContactConstraint;
  private readonly deckContactB: DeckContactConstraint;

  constructor(
    particleA: Body,
    particleB: Body,
    hullBody: Body,
    hullBoundary: HullBoundaryData,
    deckContactA: DeckContactConstraint,
    deckContactB: DeckContactConstraint,
    totalLength: number,
    options: WrapConstraint3DOptions = {},
  ) {
    super(particleA, particleB, options);
    this.hullBody = hullBody;
    this.hullBoundary = hullBoundary;
    this.deckContactA = deckContactA;
    this.deckContactB = deckContactB;
    this.totalLength = totalLength;
    this.maxForce = options.maxForce ?? Number.MAX_VALUE;

    if ((options.wakeUpBodies ?? true) && hullBody instanceof DynamicBody) {
      hullBody.wakeUp();
    }

    // Sum equation: 3-body, constrains total path length. Upper-limit only.
    this.sumEquation = new PulleyEquation(particleA, particleB, hullBody);
    this.sumEquation.maxForce = 0;
    this.sumEquation.minForce = -this.maxForce;
    this.sumEquation.enabled = false;

    const self = this;
    this.sumEquation.computeGq = function () {
      return self.position - self.totalLength;
    };

    this.equations = [this.sumEquation];
  }

  /** Set the max force for this constraint. */
  setMaxForce(maxForce: number): void {
    this.maxForce = maxForce;
    this.sumEquation.minForce = -maxForce;
  }

  update(): this {
    const eq = this.sumEquation;

    // ── 1. Straddle check ────────────────────────────────────────────
    // No straddle → no wrap. Cheap early-out; the chord constraint does
    // its usual job on its own.
    const aInside = this.deckContactA.isInside();
    const bInside = this.deckContactB.isInside();
    if (aInside === bInside) {
      eq.enabled = false;
      return this;
    }

    // ── 2. Compute peg from chord vs hull outline ────────────────────
    // Particle world positions.
    const particleA = this.bodyA;
    const particleB = this.bodyB;
    const ax = particleA.position[0];
    const ay = particleA.position[1];
    const az = particleA.z;
    const bx = particleB.position[0];
    const by = particleB.position[1];
    const bz = particleB.z;

    // Hull-local for the chord crossing test (2D at deck level).
    const localA = this.hullBody.toLocalFrame3D(ax, ay, az);
    const localB = this.hullBody.toLocalFrame3D(bx, by, bz);
    const crossing = findChordHullCrossing(
      this.hullBoundary,
      localA[0],
      localA[1],
      aInside,
      localB[0],
      localB[1],
    );
    if (!crossing) {
      eq.enabled = false;
      return this;
    }

    // Lift the peg to world space.
    const pegWorld = this.hullBody.toWorldFrame3D(
      crossing.px,
      crossing.py,
      crossing.pz,
    );
    const px = pegWorld[0];
    const py = pegWorld[1];
    const pz = pegWorld[2];

    // ── 3. Distances and unit directions ─────────────────────────────
    const dAx = ax - px;
    const dAy = ay - py;
    const dAz = az - pz;
    const dBx = bx - px;
    const dBy = by - py;
    const dBz = bz - pz;
    this.distA = Math.sqrt(dAx * dAx + dAy * dAy + dAz * dAz);
    this.distB = Math.sqrt(dBx * dBx + dBy * dBy + dBz * dBz);
    this.position = this.distA + this.distB;

    // ── 4. Enable only if the over-the-peg path is longer than the budget.
    // Otherwise the chord constraint is already sufficient.
    if (this.position <= this.totalLength) {
      eq.enabled = false;
      return this;
    }

    eq.enabled = true;
    eq.maxForce = 0;
    eq.minForce = -this.maxForce;

    // Unit direction from peg toward A.
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

    // Unit direction from peg toward B.
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

    // ── 5. Lever arms ────────────────────────────────────────────────
    // Particle anchors are the body centers, so rA = 0 and rB = 0 (the
    // angular contributions vanish), but PulleyEquation still wants the
    // fields filled. Use zeros for A/B, and the hull-center-to-peg vector
    // for C.
    const hull = this.hullBody;
    const rCx = px - hull.position[0];
    const rCy = py - hull.position[1];
    const rCz = pz - hull.z;

    // ── 6. Fill the 18-element Jacobian ──────────────────────────────
    eq.setJacobian(
      nAx,
      nAy,
      nAz,
      nBx,
      nBy,
      nBz,
      0,
      0,
      0, // rA: particle center = anchor
      rCx,
      rCy,
      rCz,
      0,
      0,
      0, // rB: particle center = anchor
    );

    return this;
  }
}
