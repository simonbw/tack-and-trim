import Constraint, { ConstraintOptions } from "./Constraint";
import ContactEquation from "../equations/ContactEquation";
import Equation from "../equations/Equation";
import RotationalLockEquation from "../equations/RotationalLockEquation";
import vec2, { Vec2 } from "../math/vec2";
import type Body from "../objects/Body";

export interface PrismaticConstraintOptions extends ConstraintOptions {
  maxForce?: number;
  localAnchorA?: Vec2;
  localAnchorB?: Vec2;
  localAxisA?: Vec2;
  disableRotationalLock?: boolean;
  upperLimit?: number;
  lowerLimit?: number;
}

// Module-level temp vectors
const worldAxisA = vec2.create();
const worldAnchorA = vec2.create();
const worldAnchorB = vec2.create();
const orientedAnchorA = vec2.create();
const orientedAnchorB = vec2.create();
const tmp = vec2.create();

/**
 * Constraint that only allows bodies to move along a line, relative to each other.
 * Also called "slider constraint".
 */
export default class PrismaticConstraint extends Constraint {
  localAnchorA: Vec2;
  localAnchorB: Vec2;
  localAxisA: Vec2;
  maxForce: number;

  /**
   * The position of anchor A relative to anchor B, along the constraint axis.
   */
  position: number = 0;

  velocity: number = 0;

  /**
   * Set to true to enable lower limit.
   */
  lowerLimitEnabled: boolean;

  /**
   * Set to true to enable upper limit.
   */
  upperLimitEnabled: boolean;

  /**
   * Lower constraint limit.
   */
  lowerLimit: number;

  /**
   * Upper constraint limit.
   */
  upperLimit: number;

  upperLimitEquation: ContactEquation;
  lowerLimitEquation: ContactEquation;

  /**
   * Equation used for the motor.
   */
  motorEquation: Equation;

  /**
   * The current motor state. Enable or disable the motor using .enableMotor
   */
  motorEnabled: boolean = false;

  /**
   * Set the target speed for the motor.
   */
  motorSpeed: number = 0;

  constructor(bodyA: Body, bodyB: Body, options: PrismaticConstraintOptions = {}) {
    super(bodyA, bodyB, Constraint.PRISMATIC, options);

    // Get anchors
    const localAnchorA = vec2.fromValues(0, 0);
    const localAxisA = vec2.fromValues(1, 0);
    const localAnchorB = vec2.fromValues(0, 0);
    if (options.localAnchorA) {
      vec2.copy(localAnchorA, options.localAnchorA);
    }
    if (options.localAxisA) {
      vec2.copy(localAxisA, options.localAxisA);
    }
    if (options.localAnchorB) {
      vec2.copy(localAnchorB, options.localAnchorB);
    }

    this.localAnchorA = localAnchorA;
    this.localAnchorB = localAnchorB;
    this.localAxisA = localAxisA;

    const maxForce =
      typeof options.maxForce !== "undefined"
        ? options.maxForce
        : Number.MAX_VALUE;
    this.maxForce = maxForce;

    // Translational part
    const trans = new Equation(bodyA, bodyB, -maxForce, maxForce);
    const ri = vec2.create();
    const rj = vec2.create();
    const gg = vec2.create();
    const t = vec2.create();

    trans.computeGq = function () {
      return vec2.dot(gg, t);
    };

    (trans as any).updateJacobian = function () {
      const G = this.G;
      const xi = bodyA.position;
      const xj = bodyB.position;
      vec2.rotate(ri, localAnchorA, bodyA.angle);
      vec2.rotate(rj, localAnchorB, bodyB.angle);
      vec2.add(gg, xj, rj);
      vec2.sub(gg, gg, xi);
      vec2.sub(gg, gg, ri);
      vec2.rotate(t, localAxisA, bodyA.angle + Math.PI / 2);

      G[0] = -t[0];
      G[1] = -t[1];
      G[2] = -vec2.crossLength(ri, t) + vec2.crossLength(t, gg);
      G[3] = t[0];
      G[4] = t[1];
      G[5] = vec2.crossLength(rj, t);
    };
    this.equations.push(trans);

    // Rotational part
    if (!options.disableRotationalLock) {
      const rot = new RotationalLockEquation(bodyA, bodyB);
      rot.maxForce = maxForce;
      rot.minForce = -maxForce;
      this.equations.push(rot);
    }

    this.lowerLimitEnabled =
      typeof options.lowerLimit !== "undefined" ? true : false;
    this.upperLimitEnabled =
      typeof options.upperLimit !== "undefined" ? true : false;
    this.lowerLimit =
      typeof options.lowerLimit !== "undefined" ? options.lowerLimit : 0;
    this.upperLimit =
      typeof options.upperLimit !== "undefined" ? options.upperLimit : 1;

    // Equations used for limits
    this.upperLimitEquation = new ContactEquation(bodyA, bodyB);
    this.lowerLimitEquation = new ContactEquation(bodyA, bodyB);

    // Set max/min forces
    this.upperLimitEquation.minForce = this.lowerLimitEquation.minForce = 0;
    this.upperLimitEquation.maxForce = this.lowerLimitEquation.maxForce = maxForce;

    // Motor equation
    this.motorEquation = new Equation(bodyA, bodyB);
    const that = this;
    const motorEquation = this.motorEquation;

    motorEquation.computeGq = function () {
      return 0;
    };
    motorEquation.computeGW = function () {
      const G = this.G;
      const bi = this.bodyA;
      const bj = this.bodyB;
      const vi = bi.velocity;
      const vj = bj.velocity;
      const wi = bi.angularVelocity;
      const wj = bj.angularVelocity;
      return this.gmult(G, vi, wi, vj, wj) + that.motorSpeed;
    };
  }

  /**
   * Update the constraint equations. Should be done if any of the bodies
   * changed position, before solving.
   */
  update(): void {
    const eqs = this.equations;
    const trans = eqs[0] as any;
    const upperLimit = this.upperLimit;
    const lowerLimit = this.lowerLimit;
    const upperLimitEquation = this.upperLimitEquation;
    const lowerLimitEquation = this.lowerLimitEquation;
    const bodyA = this.bodyA;
    const bodyB = this.bodyB;
    const localAxisA = this.localAxisA;
    const localAnchorA = this.localAnchorA;
    const localAnchorB = this.localAnchorB;

    trans.updateJacobian();

    // Transform local things to world
    vec2.rotate(worldAxisA, localAxisA, bodyA.angle);
    vec2.rotate(orientedAnchorA, localAnchorA, bodyA.angle);
    vec2.add(worldAnchorA, orientedAnchorA, bodyA.position);
    vec2.rotate(orientedAnchorB, localAnchorB, bodyB.angle);
    vec2.add(worldAnchorB, orientedAnchorB, bodyB.position);

    const relPosition = (this.position =
      vec2.dot(worldAnchorB, worldAxisA) - vec2.dot(worldAnchorA, worldAxisA));

    // Motor
    if (this.motorEnabled) {
      const G = this.motorEquation.G;
      G[0] = worldAxisA[0];
      G[1] = worldAxisA[1];
      G[2] = vec2.crossLength(worldAxisA, orientedAnchorB);
      G[3] = -worldAxisA[0];
      G[4] = -worldAxisA[1];
      G[5] = -vec2.crossLength(worldAxisA, orientedAnchorA);
    }

    if (this.upperLimitEnabled && relPosition > upperLimit) {
      vec2.scale(upperLimitEquation.normalA, worldAxisA, -1);
      vec2.sub(upperLimitEquation.contactPointA, worldAnchorA, bodyA.position);
      vec2.sub(upperLimitEquation.contactPointB, worldAnchorB, bodyB.position);
      vec2.scale(tmp, worldAxisA, upperLimit);
      vec2.add(
        upperLimitEquation.contactPointA,
        upperLimitEquation.contactPointA,
        tmp
      );
      if (eqs.indexOf(upperLimitEquation) === -1) {
        eqs.push(upperLimitEquation);
      }
    } else {
      const idx = eqs.indexOf(upperLimitEquation);
      if (idx !== -1) {
        eqs.splice(idx, 1);
      }
    }

    if (this.lowerLimitEnabled && relPosition < lowerLimit) {
      vec2.scale(lowerLimitEquation.normalA, worldAxisA, 1);
      vec2.sub(lowerLimitEquation.contactPointA, worldAnchorA, bodyA.position);
      vec2.sub(lowerLimitEquation.contactPointB, worldAnchorB, bodyB.position);
      vec2.scale(tmp, worldAxisA, lowerLimit);
      vec2.sub(
        lowerLimitEquation.contactPointB,
        lowerLimitEquation.contactPointB,
        tmp
      );
      if (eqs.indexOf(lowerLimitEquation) === -1) {
        eqs.push(lowerLimitEquation);
      }
    } else {
      const idx = eqs.indexOf(lowerLimitEquation);
      if (idx !== -1) {
        eqs.splice(idx, 1);
      }
    }
  }

  /**
   * Enable the motor
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
   * Set the constraint limits.
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
}
