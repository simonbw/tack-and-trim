import type { Body } from "../body/Body";
import { Equation } from "../equations/Equation";
import { ConstraintOptions, Constraint } from "./Constraint";

/** Options for creating a DistanceConstraint3D. */
export interface DistanceConstraint3DOptions extends ConstraintOptions {
  /** Target distance. If not set, uses current 3D distance between anchors. */
  distance?: number;
  /** 3D anchor point on bodyA in local coordinates. Default [0,0,0]. */
  localAnchorA?: [number, number, number];
  /** 3D anchor point on bodyB in local coordinates. Default [0,0,0]. */
  localAnchorB?: [number, number, number];
  /** Maximum force the constraint can apply. Default MAX_VALUE. */
  maxForce?: number;
}

/**
 * 3D distance constraint between two bodies.
 *
 * Like DistanceConstraint but operates in full 3D: computes distance using
 * toWorldFrame3D, and applies forces along all three axes (X, Y, Z) plus
 * torques on all three rotation axes (yaw, pitch, roll).
 *
 * The Jacobian G layout is:
 *   [vxA, vyA, vzA, wxA, wyA, wzA, vxB, vyB, vzB, wxB, wyB, wzB]
 *
 * For bodies without 6DOF, the Z and roll/pitch terms are still set in G
 * but have no effect because the solver's inverse mass/inertia for those
 * DOFs is zero.
 */
export class DistanceConstraint3D extends Constraint {
  localAnchorA: [number, number, number];
  localAnchorB: [number, number, number];

  /** The distance to keep. */
  distance: number;

  /** Max force to apply. */
  maxForce: number;

  /** If the upper limit is enabled or not. */
  upperLimitEnabled: boolean = false;

  /** The upper constraint limit. */
  upperLimit: number = 1;

  /** If the lower limit is enabled or not. */
  lowerLimitEnabled: boolean = false;

  /** The lower constraint limit. */
  lowerLimit: number = 0;

  /**
   * Current constraint position — the current 3D distance between
   * the world anchor points.
   */
  position: number = 0;

  constructor(
    bodyA: Body,
    bodyB: Body,
    options: DistanceConstraint3DOptions = {},
  ) {
    super(bodyA, bodyB, options);

    this.localAnchorA = options.localAnchorA
      ? [
          options.localAnchorA[0],
          options.localAnchorA[1],
          options.localAnchorA[2],
        ]
      : [0, 0, 0];
    this.localAnchorB = options.localAnchorB
      ? [
          options.localAnchorB[0],
          options.localAnchorB[1],
          options.localAnchorB[2],
        ]
      : [0, 0, 0];

    if (typeof options.distance === "number") {
      this.distance = options.distance;
    } else {
      // Use current 3D distance between anchors
      const [ax, ay, az] = bodyA.toWorldFrame3D(...this.localAnchorA);
      const [bx, by, bz] = bodyB.toWorldFrame3D(...this.localAnchorB);
      const dx = bx - ax;
      const dy = by - ay;
      const dz = bz - az;
      this.distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    const maxForce =
      options.maxForce !== undefined ? options.maxForce : Number.MAX_VALUE;
    this.maxForce = maxForce;

    // Create the equation with a custom computeGq that returns 3D violation
    const that = this;
    const normal = new Equation(bodyA, bodyB, -maxForce, maxForce);
    normal.computeGq = function () {
      const [ax, ay, az] = this.bodyA.toWorldFrame3D(...that.localAnchorA);
      const [bx, by, bz] = this.bodyB.toWorldFrame3D(...that.localAnchorB);
      const dx = bx - ax;
      const dy = by - ay;
      const dz = bz - az;
      return Math.sqrt(dx * dx + dy * dy + dz * dz) - that.distance;
    };

    this.equations = [normal];
    this.setMaxForce(maxForce);
  }

  /**
   * Update the constraint equations. Called by the solver each step.
   */
  update(): this {
    const bodyA = this.bodyA;
    const bodyB = this.bodyB;
    const normalEquation = this.equations[0];
    const G = normalEquation.G;

    // Transform local anchors to world 3D
    const [ax, ay, az] = bodyA.toWorldFrame3D(...this.localAnchorA);
    const [bx, by, bz] = bodyB.toWorldFrame3D(...this.localAnchorB);

    // Separation vector and distance
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    this.position = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // Check limits
    let violating = false;
    if (this.upperLimitEnabled) {
      if (this.position > this.upperLimit) {
        normalEquation.maxForce = 0;
        normalEquation.minForce = -this.maxForce;
        this.distance = this.upperLimit;
        violating = true;
      }
    }

    if (this.lowerLimitEnabled) {
      if (this.position < this.lowerLimit) {
        normalEquation.maxForce = this.maxForce;
        normalEquation.minForce = 0;
        this.distance = this.lowerLimit;
        violating = true;
      }
    }

    if ((this.lowerLimitEnabled || this.upperLimitEnabled) && !violating) {
      normalEquation.enabled = false;
      return this;
    }

    normalEquation.enabled = true;

    // Normalized constraint direction
    let nx: number, ny: number, nz: number;
    if (this.position > 0.0001) {
      const invDist = 1 / this.position;
      nx = dx * invDist;
      ny = dy * invDist;
      nz = dz * invDist;
    } else {
      // Degenerate: zero distance, pick arbitrary direction
      nx = 1;
      ny = 0;
      nz = 0;
    }

    // Lever arms from body centers to world anchor points
    const [pax, pay] = bodyA.position;
    const paz = bodyA.z;
    const riX = ax - pax;
    const riY = ay - pay;
    const riZ = az - paz;

    const [pbx, pby] = bodyB.position;
    const pbz = bodyB.z;
    const rjX = bx - pbx;
    const rjY = by - pby;
    const rjZ = bz - pbz;

    // 3D cross products: ri × n and rj × n
    const rixnX = riY * nz - riZ * ny;
    const rixnY = riZ * nx - riX * nz;
    const rixnZ = riX * ny - riY * nx;

    const rjxnX = rjY * nz - rjZ * ny;
    const rjxnY = rjZ * nx - rjX * nz;
    const rjxnZ = rjX * ny - rjY * nx;

    // Fill Jacobian: G = [-n, -(ri×n), n, rj×n]
    // Body A linear (force direction)
    G[0] = -nx;
    G[1] = -ny;
    G[2] = -nz;
    // Body A angular (torque from lever arm)
    G[3] = -rixnX;
    G[4] = -rixnY;
    G[5] = -rixnZ;
    // Body B linear
    G[6] = nx;
    G[7] = ny;
    G[8] = nz;
    // Body B angular
    G[9] = rjxnX;
    G[10] = rjxnY;
    G[11] = rjxnZ;

    return this;
  }

  /** Set the max force to be used */
  setMaxForce(maxForce: number): void {
    const normal = this.equations[0];
    normal.minForce = -maxForce;
    normal.maxForce = maxForce;
  }

  /** Get the max force */
  getMaxForce(): number {
    return this.equations[0].maxForce;
  }
}
