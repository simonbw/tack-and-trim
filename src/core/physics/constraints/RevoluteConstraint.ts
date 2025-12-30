import Constraint, { ConstraintOptions } from "./Constraint";
import Equation from "../equations/Equation";
import RotationalVelocityEquation from "../equations/RotationalVelocityEquation";
import RotationalLockEquation from "../equations/RotationalLockEquation";
import vec2, { Vec2 } from "../math/vec2";
import type Body from "../objects/Body";

export interface RevoluteConstraintOptions extends ConstraintOptions {
  worldPivot?: Vec2;
  localPivotA?: Vec2;
  localPivotB?: Vec2;
  maxForce?: number;
}

// Module-level temp vectors
const worldPivotA = vec2.create();
const worldPivotB = vec2.create();
const xAxis = vec2.fromValues(1, 0);
const yAxis = vec2.fromValues(0, 1);
const g = vec2.create();

/**
 * Connects two bodies at given offset points, letting them rotate relative
 * to each other around this point.
 */
export default class RevoluteConstraint extends Constraint {
  pivotA: Vec2;
  pivotB: Vec2;
  maxForce: number;
  motorEquation: RotationalVelocityEquation;

  /**
   * Indicates whether the motor is enabled. Use .enableMotor() to enable
   * the constraint motor.
   */
  motorEnabled: boolean = false;

  /**
   * The constraint position.
   */
  angle: number = 0;

  /**
   * Set to true to enable lower limit
   */
  lowerLimitEnabled: boolean = false;

  /**
   * Set to true to enable upper limit
   */
  upperLimitEnabled: boolean = false;

  /**
   * The lower limit on the constraint angle.
   */
  lowerLimit: number = 0;

  /**
   * The upper limit on the constraint angle.
   */
  upperLimit: number = 0;

  upperLimitEquation: RotationalLockEquation;
  lowerLimitEquation: RotationalLockEquation;

  constructor(bodyA: Body, bodyB: Body, options: RevoluteConstraintOptions = {}) {
    super(bodyA, bodyB, Constraint.REVOLUTE, options);

    const maxForce =
      typeof options.maxForce !== "undefined"
        ? options.maxForce
        : Number.MAX_VALUE;
    this.maxForce = maxForce;

    this.pivotA = vec2.create();
    this.pivotB = vec2.create();

    if (options.worldPivot) {
      // Compute pivotA and pivotB
      vec2.sub(this.pivotA, options.worldPivot, bodyA.position);
      vec2.sub(this.pivotB, options.worldPivot, bodyB.position);
      // Rotate to local coordinate system
      vec2.rotate(this.pivotA, this.pivotA, -bodyA.angle);
      vec2.rotate(this.pivotB, this.pivotB, -bodyB.angle);
    } else if (options.localPivotA && options.localPivotB) {
      // Get pivotA and pivotB
      vec2.copy(this.pivotA, options.localPivotA);
      vec2.copy(this.pivotB, options.localPivotB);
    }

    // Equations to be fed to the solver
    const x = new Equation(bodyA, bodyB, -maxForce, maxForce);
    const y = new Equation(bodyA, bodyB, -maxForce, maxForce);
    const that = this;

    x.computeGq = function () {
      vec2.rotate(worldPivotA, that.pivotA, bodyA.angle);
      vec2.rotate(worldPivotB, that.pivotB, bodyB.angle);
      vec2.add(g, bodyB.position, worldPivotB);
      vec2.sub(g, g, bodyA.position);
      vec2.sub(g, g, worldPivotA);
      return vec2.dot(g, xAxis);
    };

    y.computeGq = function () {
      vec2.rotate(worldPivotA, that.pivotA, bodyA.angle);
      vec2.rotate(worldPivotB, that.pivotB, bodyB.angle);
      vec2.add(g, bodyB.position, worldPivotB);
      vec2.sub(g, g, bodyA.position);
      vec2.sub(g, g, worldPivotA);
      return vec2.dot(g, yAxis);
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

  /**
   * Set the constraint angle limits.
   */
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

  update(): void {
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

    if (this.upperLimitEnabled && relAngle > upperLimit) {
      upperLimitEquation.angle = upperLimit;
      if (eqs.indexOf(upperLimitEquation) === -1) {
        eqs.push(upperLimitEquation);
      }
    } else {
      const idx = eqs.indexOf(upperLimitEquation);
      if (idx !== -1) {
        eqs.splice(idx, 1);
      }
    }

    if (this.lowerLimitEnabled && relAngle < lowerLimit) {
      lowerLimitEquation.angle = lowerLimit;
      if (eqs.indexOf(lowerLimitEquation) === -1) {
        eqs.push(lowerLimitEquation);
      }
    } else {
      const idx = eqs.indexOf(lowerLimitEquation);
      if (idx !== -1) {
        eqs.splice(idx, 1);
      }
    }

    vec2.rotate(worldPivotA, pivotA, bodyA.angle);
    vec2.rotate(worldPivotB, pivotB, bodyB.angle);

    x.G[0] = -1;
    x.G[1] = 0;
    x.G[2] = -vec2.crossLength(worldPivotA, xAxis);
    x.G[3] = 1;
    x.G[4] = 0;
    x.G[5] = vec2.crossLength(worldPivotB, xAxis);

    y.G[0] = 0;
    y.G[1] = -1;
    y.G[2] = -vec2.crossLength(worldPivotA, yAxis);
    y.G[3] = 0;
    y.G[4] = 1;
    y.G[5] = vec2.crossLength(worldPivotB, yAxis);
  }

  /**
   * Enable the rotational motor
   */
  enableMotor(): void {
    if (this.motorEnabled) {
      return;
    }
    this.equations.push(this.motorEquation);
    this.motorEnabled = true;
  }

  /**
   * Disable the rotational motor
   */
  disableMotor(): void {
    if (!this.motorEnabled) {
      return;
    }
    const i = this.equations.indexOf(this.motorEquation);
    this.equations.splice(i, 1);
    this.motorEnabled = false;
  }

  /**
   * Check if the motor is enabled.
   * @deprecated use property motorEnabled instead.
   */
  motorIsEnabled(): boolean {
    return !!this.motorEnabled;
  }

  /**
   * Set the speed of the rotational constraint motor
   */
  setMotorSpeed(speed: number): void {
    if (!this.motorEnabled) {
      return;
    }
    const i = this.equations.indexOf(this.motorEquation);
    this.equations[i].relativeVelocity = speed;
  }

  /**
   * Get the speed of the rotational constraint motor
   */
  getMotorSpeed(): number | false {
    if (!this.motorEnabled) {
      return false;
    }
    return this.motorEquation.relativeVelocity;
  }
}
