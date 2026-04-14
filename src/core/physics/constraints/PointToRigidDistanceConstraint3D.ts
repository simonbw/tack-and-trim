/**
 * 3D distance constraint between a particle-like body and a rigid body
 * with a local anchor. Specialized for rope endpoint chain links: one end
 * is a rope particle (no rotation, anchor at body center), the other is
 * a rigid boat part (hull, cleat) with a non-trivial local anchor.
 *
 * Owns a single {@link PointToRigidEquation3D}. The particle must be
 * `bodyA` by the shape's convention; callers whose natural body order has
 * the particle on side B should swap before constructing this constraint.
 *
 * Supports the same upper/lower limit toggling as `DistanceConstraint3D`
 * but skips lever-arm math on the particle side entirely.
 */
import type { Body } from "../body/Body";
import { CompatibleVector3, V3, V3d } from "../../Vector3";
import { PointToRigidEquation3D } from "../equations/PointToRigidEquation3D";
import { Constraint, ConstraintOptions } from "./Constraint";

// Module-level scratch to avoid allocating V3d on every update() call.
const SCRATCH_ANCHOR_B = new V3d(0, 0, 0);

export interface PointToRigidDistanceConstraint3DOptions
  extends ConstraintOptions {
  /** Local anchor on the rigid body (bodyB). Default [0, 0, 0]. */
  localAnchorB?: CompatibleVector3;
  /** Target distance. If omitted, uses the current 3D distance at construction time. */
  distance?: number;
  /** Maximum force the constraint can apply. Default MAX_VALUE. */
  maxForce?: number;
}

export class PointToRigidDistanceConstraint3D extends Constraint {
  /** Local anchor on the rigid body. The particle's anchor is always [0,0,0]. */
  localAnchorB: V3d;

  /** Target distance (mutated when limits are active). */
  distance: number;

  /** Max force the constraint can apply. */
  maxForce: number;

  upperLimitEnabled: boolean = false;
  upperLimit: number = 1;
  lowerLimitEnabled: boolean = false;
  lowerLimit: number = 0;

  /** Current distance between the particle and the world anchor on the rigid. */
  position: number = 0;

  private readonly equation: PointToRigidEquation3D;

  constructor(
    particle: Body,
    rigid: Body,
    options: PointToRigidDistanceConstraint3DOptions = {},
  ) {
    super(particle, rigid, options);

    this.localAnchorB = options.localAnchorB
      ? V3(options.localAnchorB)
      : new V3d(0, 0, 0);
    this.maxForce = options.maxForce ?? Number.MAX_VALUE;

    if (typeof options.distance === "number") {
      this.distance = options.distance;
    } else {
      const [bx, by, bz] = rigid.toWorldFrame3D(this.localAnchorB);
      const dx = particle.position[0] - bx;
      const dy = particle.position[1] - by;
      const dz = particle.z - bz;
      this.distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    const eq = new PointToRigidEquation3D(
      particle,
      rigid,
      -this.maxForce,
      this.maxForce,
    );
    this.equation = eq;
    this.equations = [eq];
  }

  update(): this {
    const particle = this.bodyA;
    const rigid = this.bodyB;
    const eq = this.equation;

    // World anchor point on the rigid body
    const worldB = rigid.toWorldFrame3D(this.localAnchorB, SCRATCH_ANCHOR_B);
    const bx = worldB[0];
    const by = worldB[1];
    const bz = worldB[2];

    // Separation from particle (bodyA) toward rigid anchor (bodyB). The
    // shape's convention is "n points from A to B", so `n = d / len` here.
    // Getting this direction right is load-bearing — the opposite sign
    // would produce repulsive force on a stretched constraint.
    const dx = bx - particle.position[0];
    const dy = by - particle.position[1];
    const dz = bz - particle.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    this.position = len;

    // Limit toggling (same semantics as DistanceConstraint3D)
    let target = this.distance;
    let violating = false;
    if (this.upperLimitEnabled && len > this.upperLimit) {
      eq.maxForce = 0;
      eq.minForce = -this.maxForce;
      target = this.upperLimit;
      this.distance = this.upperLimit;
      violating = true;
    }
    if (this.lowerLimitEnabled && len < this.lowerLimit) {
      eq.maxForce = this.maxForce;
      eq.minForce = 0;
      target = this.lowerLimit;
      this.distance = this.lowerLimit;
      violating = true;
    }
    if ((this.upperLimitEnabled || this.lowerLimitEnabled) && !violating) {
      eq.enabled = false;
      return this;
    }
    eq.enabled = true;

    // Position error: current distance minus target
    eq.offset = len - target;

    // Unit direction from particle toward the rigid anchor.
    let nx: number;
    let ny: number;
    let nz: number;
    if (len > 0.0001) {
      const inv = 1 / len;
      nx = dx * inv;
      ny = dy * inv;
      nz = dz * inv;
    } else {
      nx = 1;
      ny = 0;
      nz = 0;
    }
    eq.nx = nx;
    eq.ny = ny;
    eq.nz = nz;

    // Body B angular contribution: rj × n, where rj is the lever arm from
    // the rigid's center of mass to the world anchor point.
    const rjX = bx - rigid.position[0];
    const rjY = by - rigid.position[1];
    const rjZ = bz - rigid.z;
    eq.rjXnX = rjY * nz - rjZ * ny;
    eq.rjXnY = rjZ * nx - rjX * nz;
    eq.rjXnZ = rjX * ny - rjY * nx;

    return this;
  }

  setMaxForce(maxForce: number): void {
    this.maxForce = maxForce;
    this.equation.minForce = -maxForce;
    this.equation.maxForce = maxForce;
  }
}
