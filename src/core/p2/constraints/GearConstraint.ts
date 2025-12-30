import Constraint, { ConstraintOptions } from "./Constraint";
import AngleLockEquation from "../equations/AngleLockEquation";
import type Body from "../objects/Body";

export interface GearConstraintOptions extends ConstraintOptions {
  angle?: number;
  ratio?: number;
  maxTorque?: number;
}

/**
 * Constrains the angle of two bodies to each other to be equal. If a gear
 * ratio is not one, the angle of bodyA must be a multiple of the angle of bodyB.
 */
export default class GearConstraint extends Constraint {
  /**
   * The gear ratio.
   */
  ratio: number;

  /**
   * The relative angle
   */
  angle: number;

  constructor(bodyA: Body, bodyB: Body, options: GearConstraintOptions = {}) {
    super(bodyA, bodyB, Constraint.GEAR, options);

    this.ratio = options.ratio !== undefined ? options.ratio : 1;
    this.angle =
      options.angle !== undefined
        ? options.angle
        : bodyB.angle - this.ratio * bodyA.angle;

    // Send same parameters to the equation
    this.equations = [
      new AngleLockEquation(bodyA, bodyB, {
        angle: this.angle,
        ratio: this.ratio,
      }),
    ];

    // Set max torque
    if (options.maxTorque !== undefined) {
      this.setMaxTorque(options.maxTorque);
    }
  }

  update(): void {
    const eq = this.equations[0] as AngleLockEquation;
    if (eq.ratio !== this.ratio) {
      eq.setRatio(this.ratio);
    }
    eq.angle = this.angle;
  }

  /**
   * Set the max torque for the constraint.
   */
  setMaxTorque(torque: number): void {
    (this.equations[0] as AngleLockEquation).setMaxTorque(torque);
  }

  /**
   * Get the max torque for the constraint.
   */
  getMaxTorque(): number {
    return this.equations[0].maxForce;
  }
}
