/**
 * A standalone pulley (block or winch) that constrains a rope.
 *
 * The constraint always references a span-2 triple (p_i, p_{i+2}) with
 * totalLength = 2 * chainLinkLength. The interior particle p_{i+1} is the
 * "swallowed" particle, free to flow through the pulley under chain dynamics.
 * Each tick, a shift loop checks whether either anchor has reached the pulley
 * point (distA or distB ≤ ε) and bumps `indexA` by ±1. After each shift, the
 * old swallowed particle is marked as "skip" so its natural proximity to the
 * pulley doesn't trigger an immediate reverse shift (ping-pong).
 *
 * Always-span-2 means the constraint anchors are never at the pulley itself,
 * so the Jacobian never degenerates and the swallowed particle is never stuck.
 *
 * A winch is just a pulley in ratchet mode, with force application and
 * working-length queries.
 *
 * The rope doesn't know about pulleys — they're external constraints
 * layered on top.
 */

import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { Body } from "../../core/physics/body/Body";
import type { UnifiedBody } from "../../core/physics/body/UnifiedBody";
import {
  PulleyConstraint3D,
  type PulleyMode,
} from "../../core/physics/constraints/PulleyConstraint3D";
import { V3, V3d } from "../../core/Vector3";

// Module-level scratch vector reused by shiftIndex() and findInitialParticles()
// to avoid allocating a fresh V3d each tick.
const SCRATCH_PULLEY = new V3d(0, 0, 0);
import type { Rope } from "./Rope";

export interface PulleyConfig {
  /** "block" = free sliding, "winch" = starts in ratchet mode. Default "block". */
  mode?: "block" | "winch";
  /** Coulomb friction for rope sliding through this pulley. Default 0. */
  frictionCoefficient?: number;
  /** Sheave/drum radius in feet. 0 = point pulley. Default 0. */
  radius?: number;
  /** Constraint stiffness for the GS solver. Default 1e5. */
  stiffness?: number;
  /** Constraint relaxation for the GS solver. Default 12. */
  relaxation?: number;
}

export class Pulley extends BaseEntity {
  private readonly rope: Rope;
  private readonly particles: readonly UnifiedBody[];
  private readonly pulleyBody: Body;
  private readonly localAnchor: V3d;
  private readonly chainLinkLength: number;

  private readonly constraint: PulleyConstraint3D;
  /** A-side anchor index. Constraint spans (particles[indexA], particles[indexA + 2]). */
  private indexA: number;

  readonly type: "block" | "winch";
  readonly radius: number;

  /** Anchor-to-pulley distance threshold for triggering a shift. */
  private static readonly SHIFT_EPSILON_FRACTION = 0.4;
  /**
   * After a shift, the old swallowed particle becomes a new anchor. It's
   * naturally near the pulley (chain forces balance it there), so its
   * proximity would immediately trigger a reverse shift (ping-pong). We
   * skip that particle until it has drifted this far from the pulley.
   * Must be comfortably above SHIFT_EPSILON_FRACTION so the skip clears
   * before the particle could re-trigger a shift.
   */
  private static readonly SKIP_CLEAR_FRACTION = 0.7;
  /** Cap on shifts per tick to prevent pathological loops. */
  private static readonly MAX_SHIFTS_PER_TICK = 16;

  /**
   * Particle index to ignore for shift triggers. Set to the swallowed
   * particle's index after each shift; cleared once it moves away from P.
   */
  private skipParticleIdx: number = -1;

  constructor(
    rope: Rope,
    body: Body,
    localAnchor: V3d,
    config: PulleyConfig = {},
  ) {
    super();

    this.rope = rope;
    this.particles = rope.getParticles();
    this.pulleyBody = body;
    this.localAnchor = V3(localAnchor);
    this.chainLinkLength = rope.getChainLinkLength();
    this.type = config.mode ?? "block";
    this.radius = config.radius ?? 0;

    const stiffness = config.stiffness ?? 1e5;
    const relaxation = config.relaxation ?? 12;

    // Find the best span-2 anchor index for the pulley's world position
    this.indexA = this.findInitialParticles();

    // Create constraint: always spans (indexA, indexA + 2) with 2L of rope
    this.constraint = new PulleyConstraint3D(
      this.particles[this.indexA],
      this.particles[this.indexA + 2],
      body,
      {
        localAnchorA: [0, 0, 0],
        localAnchorB: [0, 0, 0],
        localAnchorC: this.localAnchor,
        totalLength: 2 * this.chainLinkLength,
        collideConnected: true,
        radius: this.radius,
      },
    );

    if (config.frictionCoefficient) {
      this.constraint.frictionCoefficient = config.frictionCoefficient;
    }
    for (const eq of this.constraint.equations) {
      eq.stiffness = stiffness;
      eq.relaxation = relaxation;
    }

    // Set solver order to interleave with chain constraints
    this.updateSolverOrder();

    this.constraints = [this.constraint];

    // Winch mode: start in ratchet
    if (this.type === "winch") {
      this.constraint.setMode("ratchet");
    }
  }

  /**
   * Find the span-2 anchor index that best straddles this pulley.
   * Returns indexA such that the constraint spans (p_indexA, p_{indexA+2}).
   */
  private findInitialParticles(): number {
    const particles = this.particles;
    const w = this.pulleyBody.toWorldFrame3D(this.localAnchor, SCRATCH_PULLEY);
    const wx = w[0];
    const wy = w[1];
    const wz = w[2];

    // Find the triple (p_i, p_{i+1}, p_{i+2}) whose two outer particles have
    // the smallest combined distance to the pulley. This picks the slot that
    // best wraps the pulley with one chain link of rope on each side.
    let bestI = 0;
    let bestCost = Infinity;
    for (let i = 0; i <= particles.length - 3; i++) {
      const a = particles[i];
      const b = particles[i + 2];
      const dAx = a.position[0] - wx,
        dAy = a.position[1] - wy,
        dAz = a.z - wz;
      const dBx = b.position[0] - wx,
        dBy = b.position[1] - wy,
        dBz = b.z - wz;
      const cost =
        Math.sqrt(dAx * dAx + dAy * dAy + dAz * dAz) +
        Math.sqrt(dBx * dBx + dBy * dBy + dBz * dBz);
      if (cost < bestCost) {
        bestCost = cost;
        bestI = i;
      }
    }

    return Math.max(0, Math.min(bestI, particles.length - 3));
  }

  /**
   * Set solver order so the pulley equation slots between the two chain
   * constraints it encloses. Chain constraints use odd orders 2*(i+1)+1.
   * The two enclosed links are 2*(indexA+1)+1 and 2*(indexA+2)+1; the
   * pulley uses 2*(indexA+1)+2, which sits strictly between them.
   */
  private updateSolverOrder(): void {
    const order = 2 * (this.indexA + 1) + 2;
    for (const eq of this.constraint.equations) {
      eq.solverOrder = order;
    }
  }

  @on("tick")
  onTick(): void {
    this.shiftIndex();
  }

  // ---- Shift loop ----

  /**
   * Shift indexA when either anchor reaches the pulley point.
   *
   * After every shift, the old swallowed particle (p_{indexA+1}) becomes
   * either the new A-anchor or B-anchor. Because chain forces naturally
   * balance it near the pulley, its proximity would immediately trigger a
   * reverse shift. To prevent this ping-pong, we record its index in
   * `skipParticleIdx` and ignore it for shift checks until it has drifted
   * away from the pulley (> SKIP_CLEAR_FRACTION * L).
   */
  private shiftIndex(): void {
    const epsilon = Pulley.SHIFT_EPSILON_FRACTION * this.chainLinkLength;
    const clearDist = Pulley.SKIP_CLEAR_FRACTION * this.chainLinkLength;
    const maxIndex = this.particles.length - 3;
    const p = this.pulleyBody.toWorldFrame3D(this.localAnchor, SCRATCH_PULLEY);
    const px = p[0];
    const py = p[1];
    const pz = p[2];

    // Clear skip once the particle has settled away from the pulley
    if (
      this.skipParticleIdx >= 0 &&
      this.particleDistTo(this.skipParticleIdx, px, py, pz) > clearDist
    ) {
      this.skipParticleIdx = -1;
    }

    for (let iter = 0; iter < Pulley.MAX_SHIFTS_PER_TICK; iter++) {
      const distA = this.particleDistTo(this.indexA, px, py, pz);
      const distB = this.particleDistTo(this.indexA + 2, px, py, pz);

      if (
        distA <= epsilon &&
        this.indexA > 0 &&
        this.indexA !== this.skipParticleIdx
      ) {
        this.skipParticleIdx = this.indexA + 1;
        this.shiftBy(-1);
        continue;
      }
      if (
        distB <= epsilon &&
        this.indexA < maxIndex &&
        this.indexA + 2 !== this.skipParticleIdx
      ) {
        this.skipParticleIdx = this.indexA + 1;
        this.shiftBy(+1);
        continue;
      }
      break;
    }
  }

  private particleDistTo(
    idx: number,
    wx: number,
    wy: number,
    wz: number,
  ): number {
    const p = this.particles[idx];
    const dx = p.position[0] - wx;
    const dy = p.position[1] - wy;
    const dz = p.z - wz;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Shift the constraint by one chain link. delta = -1 means rope is
   * trimming in (working side getting shorter, A-anchor moves further
   * toward endpoint A); delta = +1 means easing out.
   *
   * Ratchet bookkeeping: when shifting backward by one link, the new
   * A-anchor is one chain link further from endpoint A, so its distance
   * to the pulley is roughly L greater than the old anchor's. Pass that
   * delta to setParticleA so ratchetDistA tracks correctly across the swap.
   */
  private shiftBy(delta: -1 | 1): void {
    const newIndexA = this.indexA + delta;
    const ratchetDelta = -delta * this.chainLinkLength;
    this.constraint.setParticleA(
      this.particles[newIndexA],
      [0, 0, 0],
      ratchetDelta,
    );
    this.constraint.setParticleB(this.particles[newIndexA + 2], [0, 0, 0]);
    this.indexA = newIndexA;
    this.updateSolverOrder();
  }

  // ---- Winch API ----

  /**
   * Set the pulley mode.
   * - "ratchet": rope can slide in (trim) but not out.
   * - "free": rope slides both ways.
   */
  setMode(mode: PulleyMode): void {
    this.constraint.setMode(mode);
  }

  /**
   * Apply a tailing force on the tail-side particle to pull rope through.
   * Force is applied in the given world-space direction.
   *
   * @param forceMagnitude Force strength
   * @param dirX World-space X direction (unit vector)
   * @param dirY World-space Y direction (unit vector)
   * @param maxSpeed Maximum rope speed (ft/s). Force tapers to zero near limit.
   */
  applyForce(
    forceMagnitude: number,
    dirX: number,
    dirY: number,
    maxSpeed: number = Infinity,
  ): void {
    // Tail-side particle is always the B-anchor of the span-2 constraint
    const idxB = this.indexA + 2;
    if (idxB < 0 || idxB >= this.particles.length) return;

    const particle = this.particles[idxB];

    // Taper force as rope speed approaches maxSpeed
    let scale = 1;
    if (maxSpeed > 0 && isFinite(maxSpeed)) {
      const vRope = particle.velocity[0] * dirX + particle.velocity[1] * dirY;
      scale = Math.min(1, Math.max(0, 1 - vRope / maxSpeed));
    }

    const f = forceMagnitude * scale;
    particle.force[0] += dirX * f;
    particle.force[1] += dirY * f;

    // Newton's third law
    this.pulleyBody.force[0] -= dirX * f;
    this.pulleyBody.force[1] -= dirY * f;
  }

  /**
   * Approximate working length of rope on the A side (toward endpoint A).
   * Counts the chain links from endpoint A to the A-anchor (each of length
   * chainLinkLength) plus the straight-line distance from that anchor to
   * the pulley.
   */
  getWorkingLength(): number {
    return (this.indexA + 1) * this.chainLinkLength + this.constraint.distA;
  }

  /**
   * Move the pulley so the working length is approximately `targetLength`.
   * Used to position rope at startup.
   */
  setWorkingLength(targetLength: number): void {
    // Subtract 2 because in span-2 the pulley sits ~2 links beyond the
    // A-anchor (one full chain link plus one swallowed-particle gap).
    const targetIndexA = Math.max(
      0,
      Math.min(
        this.particles.length - 3,
        Math.round(targetLength / this.chainLinkLength) - 2,
      ),
    );

    this.constraint.setParticleA(this.particles[targetIndexA], [0, 0, 0]);
    this.constraint.setParticleB(this.particles[targetIndexA + 2], [0, 0, 0]);
    this.indexA = targetIndexA;
    this.updateSolverOrder();

    // Reset skip — anchor changed externally
    this.skipParticleIdx = -1;

    if (this.constraint.mode === "ratchet") {
      this.constraint.ratchetDistA = Infinity;
    }
  }

  /** World position of this pulley. */
  getWorldPosition(): V3d {
    return this.pulleyBody.toWorldFrame3D(this.localAnchor);
  }
}
