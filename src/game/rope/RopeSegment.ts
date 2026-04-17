/**
 * A single segment of rope between two adjacent particles.
 *
 * Owns the chain distance constraint, pairwise internal friction, and
 * direction-aware fluid drag (split into normal/tangent components based
 * on the segment's orientation in the flow).
 *
 * Each segment owns its own WindQuery and/or WaterQuery at the segment
 * midpoint, batched into the global query system.
 */

import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { Body } from "../../core/physics/body/Body";
import type { UnifiedBody } from "../../core/physics/body/UnifiedBody";
import type {
  DeckContactConstraint,
  HullBoundaryData,
} from "../../core/physics/constraints/DeckContactConstraint";
import { DistanceConstraint3D } from "../../core/physics/constraints/DistanceConstraint3D";
import { WrapConstraint3D } from "../../core/physics/constraints/WrapConstraint3D";
import { V, V2d } from "../../core/Vector";
import { LBF_TO_ENGINE, RHO_AIR, RHO_WATER } from "../physics-constants";
import { WaterQuery } from "../world/water/WaterQuery";
import { WindQuery } from "../world/wind/WindQuery";

export interface RopeSegmentConfig {
  /** Rest length of the segment (= chain link length). */
  length: number;
  /** Constraint stiffness for the GS solver. */
  stiffness: number;
  /** Constraint relaxation. */
  relaxation: number;
  /** Lower distance limit as a fraction of length. 0 = disabled. */
  minLinkFraction: number;
  /** Solver order for chain processing (interleaves with pulleys). */
  solverOrder: number;
  /** Internal friction coefficient (1/s). 0 = disabled. */
  internalFriction: number;
  /** Drag config; if omitted, no drag. */
  drag?: {
    airDrag: boolean;
    waterDrag: boolean;
    /** Rope diameter in feet. */
    diameter: number;
    /** Cylinder cross-flow drag coefficient (~1.2). */
    cdNormal: number;
    /** Skin friction coefficient for axial flow (~0.02). */
    cdTangent: number;
  };
  /**
   * Hull wrap constraint config. If present, the segment pre-creates a
   * {@link WrapConstraint3D} alongside its chain constraint that activates
   * only while the two particles straddle the hull — modelling the rope
   * wrapping around the gunwale so tension transmits over the edge rather
   * than through the wall.
   */
  wrap?: {
    hullBody: Body;
    hullBoundary: HullBoundaryData;
    deckContactA: DeckContactConstraint;
    deckContactB: DeckContactConstraint;
  };
}

export class RopeSegment extends BaseEntity {
  private readonly particleA: UnifiedBody;
  private readonly particleB: UnifiedBody;
  private readonly length: number;
  private readonly internalFriction: number;

  // Drag state
  private readonly airDrag: boolean;
  private readonly waterDrag: boolean;
  private readonly dragNormalCoef: number; // 0.5 * Cd_n * d * L
  private readonly dragTangentCoef: number; // 0.5 * Cf * π * d * L

  // Single-point query at segment midpoint
  private readonly queryPoint: V2d;
  private readonly queryPoints: V2d[];
  private windQuery: WindQuery | null = null;
  private waterQuery: WaterQuery | null = null;

  constructor(
    particleA: UnifiedBody,
    particleB: UnifiedBody,
    config: RopeSegmentConfig,
  ) {
    super();

    this.particleA = particleA;
    this.particleB = particleB;
    this.length = config.length;
    this.internalFriction = config.internalFriction;

    // Chain constraint — particle-to-particle specialization skips all the
    // angular Jacobian work and reads body positions directly, which is a
    // big hot-path win for rope chains.
    const c = new DistanceConstraint3D(particleA, particleB, {
      distance: config.length,
      collideConnected: true,
    });
    c.upperLimitEnabled = true;
    c.upperLimit = config.length;
    c.lowerLimitEnabled = config.minLinkFraction > 0;
    c.lowerLimit = config.length * config.minLinkFraction;
    for (const eq of c.equations) {
      eq.stiffness = config.stiffness;
      eq.relaxation = config.relaxation;
      eq.solverOrder = config.solverOrder;
    }
    this.constraints = [c];

    // Wrap constraint: disabled by default, activates only while the two
    // particles straddle the hull. Matches the chain constraint's stiffness
    // and solver order so the wrap bite-down is consistent with the chord
    // pull on this segment.
    if (config.wrap) {
      const wrap = new WrapConstraint3D(
        particleA,
        particleB,
        config.wrap.hullBody,
        config.wrap.hullBoundary,
        config.wrap.deckContactA,
        config.wrap.deckContactB,
        config.length,
        { collideConnected: true, wakeUpBodies: false },
      );
      for (const eq of wrap.equations) {
        eq.stiffness = config.stiffness;
        eq.relaxation = config.relaxation;
        eq.solverOrder = config.solverOrder;
      }
      this.constraints.push(wrap);
    }

    // Drag setup
    this.airDrag = config.drag?.airDrag ?? false;
    this.waterDrag = config.drag?.waterDrag ?? false;
    if (config.drag) {
      const d = config.drag.diameter;
      const L = config.length;
      this.dragNormalCoef = 0.5 * config.drag.cdNormal * d * L;
      this.dragTangentCoef = 0.5 * config.drag.cdTangent * Math.PI * d * L;
    } else {
      this.dragNormalCoef = 0;
      this.dragTangentCoef = 0;
    }

    // Query point at midpoint
    this.queryPoint = V(
      (particleA.position[0] + particleB.position[0]) * 0.5,
      (particleA.position[1] + particleB.position[1]) * 0.5,
    );
    this.queryPoints = [this.queryPoint];

    if (this.airDrag) {
      this.windQuery = this.addChild(new WindQuery(() => this.queryPoints));
    }
    if (this.waterDrag) {
      this.waterQuery = this.addChild(new WaterQuery(() => this.queryPoints));
    }
  }

  @on("tick")
  onTick({
    dt,
  }: import("../../core/entity/Entity").GameEventMap["tick"]): void {
    const a = this.particleA;
    const b = this.particleB;

    // Sync query point to current midpoint
    const mx = (a.position[0] + b.position[0]) * 0.5;
    const my = (a.position[1] + b.position[1]) * 0.5;
    const mz = (a.z + b.z) * 0.5;
    this.queryPoint.set(mx, my);

    this.applyInternalFriction(dt);
    this.applyDrag(mx, my, mz);
  }

  /**
   * Damp relative velocity between the two particles. Kills high-frequency
   * oscillation (guitar-string modes) without affecting bulk motion.
   */
  private applyInternalFriction(dt: number): void {
    const c = this.internalFriction;
    if (c <= 0) return;

    // Clamp so the damping force can't reverse relative velocity in one tick
    const cEff = Math.min(c, 0.9 / dt);

    const a = this.particleA;
    const b = this.particleB;

    const dvx = b.velocity[0] - a.velocity[0];
    const dvy = b.velocity[1] - a.velocity[1];
    const dvz = b.zVelocity - a.zVelocity;

    // Harmonic mean of masses for symmetric, mass-independent damping
    const mHarm = (a.mass * b.mass) / (a.mass + b.mass);
    const fx = cEff * mHarm * dvx;
    const fy = cEff * mHarm * dvy;
    const fz = cEff * mHarm * dvz;

    a.applyForce3D(fx, fy, fz, 0, 0, 0);
    b.applyForce3D(-fx, -fy, -fz, 0, 0, 0);
  }

  /**
   * Apply fluid drag with normal/tangent decomposition.
   *
   * The midpoint relative velocity is split into a component along the
   * segment (skin friction, low Cd) and perpendicular to it (cross-flow,
   * high Cd). This is the Morison-equation form for slender cylinders.
   */
  private applyDrag(mx: number, my: number, mz: number): void {
    if (this.dragNormalCoef <= 0) return;

    const a = this.particleA;
    const b = this.particleB;

    // Determine medium and fluid velocity at midpoint
    const waterAvail = this.waterQuery != null && this.waterQuery.length > 0;
    const windAvail = this.windQuery != null && this.windQuery.length > 0;

    let rho: number;
    let fluidVx: number;
    let fluidVy: number;

    if (waterAvail) {
      const water = this.waterQuery!.get(0);
      if (this.waterDrag && mz <= water.surfaceHeight) {
        rho = RHO_WATER;
        const wv = water.velocity;
        fluidVx = wv.x;
        fluidVy = wv.y;
      } else if (windAvail) {
        rho = RHO_AIR;
        const wv = this.windQuery!.get(0).velocity;
        fluidVx = wv.x;
        fluidVy = wv.y;
      } else {
        return;
      }
    } else if (this.airDrag && windAvail) {
      rho = RHO_AIR;
      const wv = this.windQuery!.get(0).velocity;
      fluidVx = wv.x;
      fluidVy = wv.y;
    } else {
      return;
    }

    // Midpoint velocity (avg of two endpoints) relative to fluid
    const midVx = (a.velocity[0] + b.velocity[0]) * 0.5;
    const midVy = (a.velocity[1] + b.velocity[1]) * 0.5;
    const midVz = (a.zVelocity + b.zVelocity) * 0.5;
    const vrx = midVx - fluidVx;
    const vry = midVy - fluidVy;
    const vrz = midVz; // fluid has no vertical component

    // Segment tangent (3D unit vector along the rope)
    const dx = b.position[0] - a.position[0];
    const dy = b.position[1] - a.position[1];
    const dz = b.z - a.z;
    const segLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (segLen < 1e-6) return;
    const tx = dx / segLen;
    const ty = dy / segLen;
    const tz = dz / segLen;

    // Decompose v_rel into tangential and normal components
    const vt = vrx * tx + vry * ty + vrz * tz;
    const vtx = vt * tx;
    const vty = vt * ty;
    const vtz = vt * tz;
    const vnx = vrx - vtx;
    const vny = vry - vty;
    const vnz = vrz - vtz;

    const vnMag = Math.sqrt(vnx * vnx + vny * vny + vnz * vnz);
    const vtMag = Math.abs(vt);

    // Normal drag: F_n = -0.5 * rho * Cd_n * d * L * |v_n| * v_n
    let fNx = 0,
      fNy = 0,
      fNz = 0;
    if (vnMag > 0.001) {
      const fNmag = rho * this.dragNormalCoef * vnMag * vnMag * LBF_TO_ENGINE;
      // Stability clamp: can't reverse relative velocity in one tick
      const totalMass = a.mass + b.mass;
      const maxF = totalMass * vnMag * 60;
      const clamped = Math.min(fNmag, maxF);
      const s = -clamped / vnMag;
      fNx = s * vnx;
      fNy = s * vny;
      fNz = s * vnz;
    }

    // Tangent drag (skin friction): F_t = -0.5 * rho * Cf * π * d * L * |v_t| * v_t
    // Direction opposes vt*tangent (which is the tangential velocity vector)
    let fTx = 0,
      fTy = 0,
      fTz = 0;
    if (vtMag > 0.001) {
      const fTmag = rho * this.dragTangentCoef * vtMag * vtMag * LBF_TO_ENGINE;
      const totalMass = a.mass + b.mass;
      const maxF = totalMass * vtMag * 60;
      const clamped = Math.min(fTmag, maxF);
      // Force = -clamped * (vt_vector / |vt_vector|) = -clamped * sign(vt) * tangent
      const s = -clamped * Math.sign(vt);
      fTx = s * tx;
      fTy = s * ty;
      fTz = s * tz;
    }

    // Total force, split equally between the two endpoint particles
    const fx = (fNx + fTx) * 0.5;
    const fy = (fNy + fTy) * 0.5;
    const fz = (fNz + fTz) * 0.5;
    a.applyForce3D(fx, fy, fz, 0, 0, 0);
    b.applyForce3D(fx, fy, fz, 0, 0, 0);
  }
}
