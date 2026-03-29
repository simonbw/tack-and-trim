import { CompatibleVector, V, V2d } from "../../Vector";
import type { Body } from "../body/Body";
import { Equation } from "../equations/Equation";
import { RotationalLockEquation } from "../equations/RotationalLockEquation";
import { RotationalVelocityEquation } from "../equations/RotationalVelocityEquation";
import { ConstraintOptions, Constraint } from "./Constraint";

/** Options for creating a RevoluteConstraint. */
export interface RevoluteConstraintOptions extends ConstraintOptions {
  /** Pivot point in world coordinates (converted to local pivots). */
  worldPivot?: CompatibleVector;
  /** Pivot point on bodyA in local coordinates. */
  localPivotA?: CompatibleVector;
  /** Pivot point on bodyB in local coordinates. */
  localPivotB?: CompatibleVector;
  /** Z-height of pivot on bodyA in body-local frame. Default 0. */
  localPivotZA?: number;
  /** Z-height of pivot on bodyB in body-local frame. Default 0. */
  localPivotZB?: number;
  /** Maximum force the constraint can apply. Default MAX_VALUE. */
  maxForce?: number;
}

/**
 * Connects two bodies at given offset points, letting them rotate relative
 * to each other around this point.
 */
export class RevoluteConstraint extends Constraint {
  pivotA: V2d;
  pivotB: V2d;
  /** Z-height of pivot in body-local frame. Creates roll/pitch coupling for 6DOF bodies. */
  pivotZA: number;
  pivotZB: number;
  maxForce: number;
  motorEquation: RotationalVelocityEquation;

  /**
   * Indicates whether the motor is enabled. Use .enableMotor() to enable
   * the constraint motor.
   */
  motorEnabled: boolean = false;

  /** The constraint position. */
  angle: number = 0;

  /** Set to true to enable lower limit */
  lowerLimitEnabled: boolean = false;

  /** Set to true to enable upper limit */
  upperLimitEnabled: boolean = false;

  /** The lower limit on the constraint angle. */
  lowerLimit: number = 0;

  /** The upper limit on the constraint angle. */
  upperLimit: number = 0;

  upperLimitEquation: RotationalLockEquation;
  lowerLimitEquation: RotationalLockEquation;

  /** Tracks whether upper limit equation is currently in the equations array */
  private upperLimitActive: boolean = false;
  /** Tracks whether lower limit equation is currently in the equations array */
  private lowerLimitActive: boolean = false;

  constructor(
    bodyA: Body,
    bodyB: Body,
    options: RevoluteConstraintOptions = {},
  ) {
    super(bodyA, bodyB, options);

    const maxForce =
      typeof options.maxForce !== "undefined"
        ? options.maxForce
        : Number.MAX_VALUE;
    this.maxForce = maxForce;

    this.pivotA = V();
    this.pivotB = V();
    this.pivotZA = options.localPivotZA ?? 0;
    this.pivotZB = options.localPivotZB ?? 0;

    if (options.worldPivot) {
      // Compute pivotA and pivotB
      this.pivotA.set(options.worldPivot).isub(bodyA.position);
      this.pivotB.set(options.worldPivot).isub(bodyB.position);
      // Rotate to local coordinate system
      this.pivotA.irotate(-bodyA.angle);
      this.pivotB.irotate(-bodyB.angle);
    } else if (options.localPivotA && options.localPivotB) {
      // Get pivotA and pivotB
      this.pivotA.set(options.localPivotA);
      this.pivotB.set(options.localPivotB);
    }

    // Equations to be fed to the solver
    const x = new Equation(bodyA, bodyB, -maxForce, maxForce);
    const y = new Equation(bodyA, bodyB, -maxForce, maxForce);
    const that = this;

    const xAxis = V(1, 0);
    const yAxis = V(0, 1);

    x.computeGq = function () {
      // Use orientation matrix to compute 3D world-frame pivot XY
      const RA = bodyA.orientation;
      const pA = that.pivotA;
      const zA = that.pivotZA;
      const wpAx = RA[0] * pA.x + RA[1] * pA.y + RA[2] * zA;

      const RB = bodyB.orientation;
      const pB = that.pivotB;
      const zB = that.pivotZB;
      const wpBx = RB[0] * pB.x + RB[1] * pB.y + RB[2] * zB;

      return bodyB.position[0] + wpBx - bodyA.position[0] - wpAx;
    };

    y.computeGq = function () {
      const RA = bodyA.orientation;
      const pA = that.pivotA;
      const zA = that.pivotZA;
      const wpAy = RA[3] * pA.x + RA[4] * pA.y + RA[5] * zA;

      const RB = bodyB.orientation;
      const pB = that.pivotB;
      const zB = that.pivotZB;
      const wpBy = RB[3] * pB.x + RB[4] * pB.y + RB[5] * zB;

      return bodyB.position[1] + wpBy - bodyA.position[1] - wpAy;
    };

    x.minForce = y.minForce = -maxForce;
    x.maxForce = y.maxForce = maxForce;

    this.equations = [x, y];

    this.motorEquation = new RotationalVelocityEquation(bodyA, bodyB);
    this.upperLimitEquation = new RotationalLockEquation(bodyA, bodyB);
    this.lowerLimitEquation = new RotationalLockEquation(bodyA, bodyB);
    this.upperLimitEquation.minForce = 0;
    this.lowerLimitEquation.maxForce = 0;
  }

  /** Set the constraint angle limits. */
  setLimits(lower: number | undefined, upper: number | undefined): void {
    if (typeof lower === "number") {
      this.lowerLimit = lower;
      this.lowerLimitEnabled = true;
    } else {
      this.lowerLimit = 0;
      this.lowerLimitEnabled = false;
    }

    if (typeof upper === "number") {
      this.upperLimit = upper;
      this.upperLimitEnabled = true;
    } else {
      this.upperLimit = 0;
      this.upperLimitEnabled = false;
    }
  }

  update(): this {
    const bodyA = this.bodyA;
    const bodyB = this.bodyB;
    const pivotA = this.pivotA;
    const pivotB = this.pivotB;
    const eqs = this.equations;
    const x = eqs[0];
    const y = eqs[1];
    const upperLimit = this.upperLimit;
    const lowerLimit = this.lowerLimit;
    const upperLimitEquation = this.upperLimitEquation;
    const lowerLimitEquation = this.lowerLimitEquation;

    const relAngle = (this.angle = bodyB.angle - bodyA.angle);

    // Use tracking flags instead of indexOf() for O(1) checks
    if (this.upperLimitEnabled && relAngle > upperLimit) {
      upperLimitEquation.angle = upperLimit;
      if (!this.upperLimitActive) {
        eqs.push(upperLimitEquation);
        this.upperLimitActive = true;
      }
    } else if (this.upperLimitActive) {
      const idx = eqs.indexOf(upperLimitEquation);
      eqs.splice(idx, 1);
      this.upperLimitActive = false;
    }

    if (this.lowerLimitEnabled && relAngle < lowerLimit) {
      lowerLimitEquation.angle = lowerLimit;
      if (!this.lowerLimitActive) {
        eqs.push(lowerLimitEquation);
        this.lowerLimitActive = true;
      }
    } else if (this.lowerLimitActive) {
      const idx = eqs.indexOf(lowerLimitEquation);
      eqs.splice(idx, 1);
      this.lowerLimitActive = false;
    }

    // Compute 3D world-frame pivot vectors using orientation matrices.
    // For 3DOF bodies, orientation is just yaw rotation with z unchanged.
    // For 6DOF bodies, the full rotation matrix transforms (pivotXY, pivotZ).
    const RA = bodyA.orientation;
    const rAx = RA[0] * pivotA.x + RA[1] * pivotA.y + RA[2] * this.pivotZA;
    const rAy = RA[3] * pivotA.x + RA[4] * pivotA.y + RA[5] * this.pivotZA;
    const rAz = RA[6] * pivotA.x + RA[7] * pivotA.y + RA[8] * this.pivotZA;

    const RB = bodyB.orientation;
    const rBx = RB[0] * pivotB.x + RB[1] * pivotB.y + RB[2] * this.pivotZB;
    const rBy = RB[3] * pivotB.x + RB[4] * pivotB.y + RB[5] * this.pivotZB;
    const rBz = RB[6] * pivotB.x + RB[7] * pivotB.y + RB[8] * this.pivotZB;

    // X-position equation: constrain x-separation at pivot.
    // d/dwA of -(rA × x̂) = -(0, rAz, -rAy) = (0, -rAz, rAy)
    // d/dwB of +(rB × x̂) = (0, rBz, -rBy)
    x.G[0] = -1;
    x.G[1] = 0;
    x.G[3] = 0;
    x.G[4] = -rAz;
    x.G[5] = rAy;
    x.G[6] = 1;
    x.G[7] = 0;
    x.G[9] = 0;
    x.G[10] = rBz;
    x.G[11] = -rBy;

    // Y-position equation: constrain y-separation at pivot.
    // d/dwA of -(rA × ŷ) = -(−rAz, 0, rAx) = (rAz, 0, -rAx)
    // d/dwB of +(rB × ŷ) = (−rBz, 0, rBx)
    y.G[0] = 0;
    y.G[1] = -1;
    y.G[3] = rAz;
    y.G[4] = 0;
    y.G[5] = -rAx;
    y.G[6] = 0;
    y.G[7] = 1;
    y.G[9] = -rBz;
    y.G[10] = 0;
    y.G[11] = rBx;
    return this;
  }

  /** Enable the rotational motor */
  enableMotor(): void {
    if (this.motorEnabled) {
      return;
    }
    this.equations.push(this.motorEquation);
    this.motorEnabled = true;
  }

  /** Disable the rotational motor */
  disableMotor(): void {
    if (!this.motorEnabled) {
      return;
    }
    const i = this.equations.indexOf(this.motorEquation);
    this.equations.splice(i, 1);
    this.motorEnabled = false;
  }

  /** Set the speed of the rotational constraint motor */
  setMotorSpeed(speed: number): void {
    if (!this.motorEnabled) {
      return;
    }
    // Direct access instead of indexOf() - we already have the reference
    this.motorEquation.relativeVelocity = speed;
  }

  /** Get the speed of the rotational constraint motor */
  getMotorSpeed(): number | false {
    if (!this.motorEnabled) {
      return false;
    }
    return this.motorEquation.relativeVelocity;
  }
}
