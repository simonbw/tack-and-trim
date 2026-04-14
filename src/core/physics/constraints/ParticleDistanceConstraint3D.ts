/**
 * 3D distance constraint between two particle-like bodies whose anchors are
 * at the body center (no lever arm). Specialized for rope chain links — it
 * owns a single {@link ParticleDistanceEquation3D} and its `update()` reads
 * body positions directly instead of going through `toWorldFrame3D` + cross
 * products.
 *
 * Supports the same upper/lower limit toggling as `DistanceConstraint3D`.
 * Unlike the general constraint, it does not accept local anchor offsets —
 * the anchor is always the body center.
 */
import type { Body } from "../body/Body";
import { ParticleDistanceEquation3D } from "../equations/ParticleDistanceEquation3D";
import { Constraint, ConstraintOptions } from "./Constraint";

export interface ParticleDistanceConstraint3DOptions extends ConstraintOptions {
  /** Target distance. Required. */
  distance: number;
  /** Maximum force the constraint can apply. Default MAX_VALUE. */
  maxForce?: number;
}

export class ParticleDistanceConstraint3D extends Constraint {
  /** The target distance for the constraint (mutated when limits are active). */
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

  /** Current distance between the bodies (refreshed by update()). */
  position: number = 0;

  private readonly equation: ParticleDistanceEquation3D;

  constructor(
    bodyA: Body,
    bodyB: Body,
    options: ParticleDistanceConstraint3DOptions,
  ) {
    super(bodyA, bodyB, options);

    this.distance = options.distance;
    this.maxForce = options.maxForce ?? Number.MAX_VALUE;

    const eq = new ParticleDistanceEquation3D(
      bodyA,
      bodyB,
      -this.maxForce,
      this.maxForce,
    );
    eq.distance = this.distance;
    this.equation = eq;
    this.equations = [eq];
  }

  /**
   * Refresh the constraint's direction vector and handle upper/lower limit
   * toggling. Called by the solver each substep.
   */
  update(): this {
    const bodyA = this.bodyA;
    const bodyB = this.bodyB;
    const eq = this.equation;

    const dx = bodyB.position[0] - bodyA.position[0];
    const dy = bodyB.position[1] - bodyA.position[1];
    const dz = bodyB.z - bodyA.z;

    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    this.position = len;
    eq.position = len;

    // Limit toggling: same semantics as DistanceConstraint3D.
    let violating = false;
    if (this.upperLimitEnabled && len > this.upperLimit) {
      eq.maxForce = 0;
      eq.minForce = -this.maxForce;
      eq.distance = this.upperLimit;
      this.distance = this.upperLimit;
      violating = true;
    }
    if (this.lowerLimitEnabled && len < this.lowerLimit) {
      eq.maxForce = this.maxForce;
      eq.minForce = 0;
      eq.distance = this.lowerLimit;
      this.distance = this.lowerLimit;
      violating = true;
    }
    if ((this.upperLimitEnabled || this.lowerLimitEnabled) && !violating) {
      eq.enabled = false;
      return this;
    }
    eq.enabled = true;

    // Unit direction (fallback to +x when degenerate)
    if (len > 0.0001) {
      const inv = 1 / len;
      eq.nx = dx * inv;
      eq.ny = dy * inv;
      eq.nz = dz * inv;
    } else {
      eq.nx = 1;
      eq.ny = 0;
      eq.nz = 0;
    }

    return this;
  }

  /** Set the max force for this constraint. */
  setMaxForce(maxForce: number): void {
    this.maxForce = maxForce;
    this.equation.minForce = -maxForce;
    this.equation.maxForce = maxForce;
  }
}
