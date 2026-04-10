/**
 * A standalone pulley (block or winch) that constrains a rope.
 *
 * The pulley finds the two nearest particles on the rope, creates a
 * PulleyConstraint3D between them, and runs a two-mode state machine
 * (straddle ↔ contained) each tick to track which particles it spans.
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
import type { DynamicBody } from "../../core/physics/body/DynamicBody";
import {
  PulleyConstraint3D,
  type PulleyMode,
} from "../../core/physics/constraints/PulleyConstraint3D";
import type { V2d } from "../../core/Vector";
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

/**
 * Straddle/contained state for the pulley's position along the particle chain.
 *
 * - Half-integer (e.g. 3.5): straddle mode — pulley sits between p_3 and p_4,
 *   constraint spans 1 chain link.
 * - Integer (e.g. 3): contained mode — pulley "swallows" p_3,
 *   constraint spans p_2 to p_4 (2 chain links).
 */

export class Pulley extends BaseEntity {
  private readonly rope: Rope;
  private readonly particles: readonly DynamicBody[];
  private readonly pulleyBody: Body;
  private readonly localAnchor: [number, number, number];
  private readonly chainLinkLength: number;

  private readonly constraint: PulleyConstraint3D;
  private state: number;
  private indexA: number;

  readonly type: "block" | "winch";
  readonly radius: number;

  /**
   * Fraction of chainLinkLength: particle must be this close to enter
   * contained mode.
   */
  private static readonly CONTAIN_ENTER_FRACTION = 0.25;
  /**
   * Fraction of chainLinkLength: contained particle must drift this far
   * to exit contained mode. Wider than enter to prevent oscillation.
   */
  private static readonly CONTAIN_EXIT_FRACTION = 0.5;

  constructor(
    rope: Rope,
    body: Body,
    localAnchor: V2d,
    z: number,
    config: PulleyConfig = {},
  ) {
    super();

    this.rope = rope;
    this.particles = rope.getParticles();
    this.pulleyBody = body;
    this.localAnchor = [localAnchor.x, localAnchor.y, z];
    this.chainLinkLength = rope.getChainLinkLength();
    this.type = config.mode ?? "block";
    this.radius = config.radius ?? 0;

    const stiffness = config.stiffness ?? 1e5;
    const relaxation = config.relaxation ?? 12;

    // Find the two particles nearest to the pulley's world position
    const [indexA, indexB] = this.findInitialParticles();
    this.indexA = indexA;
    this.state = indexA + 0.5; // start in straddle mode

    // Create constraint
    this.constraint = new PulleyConstraint3D(
      this.particles[indexA],
      this.particles[indexB],
      body,
      {
        localAnchorA: [0, 0, 0],
        localAnchorB: [0, 0, 0],
        localAnchorC: this.localAnchor,
        totalLength: this.chainLinkLength,
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
   * Find the two adjacent particles that best straddle this pulley's
   * world position. Returns [indexA, indexB] where indexB = indexA + 1.
   */
  private findInitialParticles(): [number, number] {
    const particles = this.particles;
    const [wx, wy, wz] = this.pulleyBody.toWorldFrame3D(...this.localAnchor);

    // Find the pair of adjacent particles whose total distance through the
    // pulley is smallest. This picks the pair that genuinely straddles the
    // pulley, regardless of which side the nearest particle is on.
    let bestPair = 0;
    let bestCost = Infinity;
    for (let i = 0; i < particles.length - 1; i++) {
      const a = particles[i];
      const b = particles[i + 1];
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
        bestPair = i;
      }
    }

    // Ensure at least one particle on each side for contained mode
    const indexA = Math.max(1, Math.min(bestPair, particles.length - 2));
    return [indexA, indexA + 1];
  }

  /**
   * Set solver order so pulley equations interleave with chain constraints.
   * Chain constraints use odd orders (1, 3, 5, ...).
   * Pulleys use even orders: 2 * (indexA + 1) + 2.
   */
  private updateSolverOrder(): void {
    const order = 2 * (this.indexA + 1) + 2;
    for (const eq of this.constraint.equations) {
      eq.solverOrder = order;
    }
  }

  @on("tick")
  onTick(): void {
    this.updateState();
  }

  // ---- State machine ----

  private updateState(): void {
    const enterDist = Pulley.CONTAIN_ENTER_FRACTION * this.chainLinkLength;
    const exitDist = Pulley.CONTAIN_EXIT_FRACTION * this.chainLinkLength;

    const [px, py, pz] = this.pulleyBody.toWorldFrame3D(...this.localAnchor);

    if (!Number.isInteger(this.state)) {
      // ---- Straddle mode ----
      const idxA = this.state - 0.5;
      const idxB = this.state + 0.5;
      const distA = this.particleDistTo(idxA, px, py, pz);
      const distB = this.particleDistTo(idxB, px, py, pz);

      if (distA < enterDist && this.canContain(idxA)) {
        this.state = idxA;
        this.applyConstraint(idxA - 1, idxA + 1, 2);
      } else if (distB < enterDist && this.canContain(idxB)) {
        this.state = idxB;
        this.applyConstraint(idxB - 1, idxB + 1, 2);
      }
    } else {
      // ---- Contained mode ----
      const containedIdx = this.state;
      const distContained = this.particleDistTo(containedIdx, px, py, pz);

      if (distContained > exitDist) {
        const canLow = containedIdx - 1 >= 0;
        const canHigh = containedIdx + 1 < this.particles.length;
        const costLow = canLow
          ? this.particleDistTo(containedIdx - 1, px, py, pz) + distContained
          : Infinity;
        const costHigh = canHigh
          ? distContained + this.particleDistTo(containedIdx + 1, px, py, pz)
          : Infinity;

        if (costLow <= costHigh && canLow) {
          this.state = containedIdx - 0.5;
          this.applyConstraint(containedIdx - 1, containedIdx, 1);
        } else if (canHigh) {
          this.state = containedIdx + 0.5;
          this.applyConstraint(containedIdx, containedIdx + 1, 1);
        }
      }
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

  private canContain(idx: number): boolean {
    return idx > 0 && idx < this.particles.length - 1;
  }

  private applyConstraint(
    indexA: number,
    indexB: number,
    linkSpan: number,
  ): void {
    const ratchetDelta = (this.indexA - indexA) * this.chainLinkLength;
    this.constraint.setParticleA(
      this.particles[indexA],
      [0, 0, 0],
      ratchetDelta,
    );
    this.constraint.setParticleB(this.particles[indexB], [0, 0, 0]);
    this.constraint.totalLength = linkSpan * this.chainLinkLength;
    this.indexA = indexA;
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
    // Get the tail-side particle (toward endpoint B / free end)
    const idxB = Number.isInteger(this.state)
      ? this.state + 1
      : this.state + 0.5;
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
   */
  getWorkingLength(): number {
    const idxA = Number.isInteger(this.state)
      ? this.state - 1
      : this.state - 0.5;
    return (idxA + 1) * this.chainLinkLength + this.constraint.distA;
  }

  /**
   * Move the pulley so the working length is approximately `targetLength`.
   * Used to position rope at startup.
   */
  setWorkingLength(targetLength: number): void {
    const targetIndexA = Math.max(
      0,
      Math.min(
        this.particles.length - 2,
        Math.round(targetLength / this.chainLinkLength) - 1,
      ),
    );
    const targetIndexB = targetIndexA + 1;

    this.applyConstraint(targetIndexA, targetIndexB, 1);
    this.state = targetIndexA + 0.5;

    if (this.constraint.mode === "ratchet") {
      this.constraint.ratchetDistA = Infinity;
    }
  }

  /** World position of this pulley. */
  getWorldPosition(): [number, number, number] {
    return this.pulleyBody.toWorldFrame3D(...this.localAnchor);
  }
}
