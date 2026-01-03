import type Body from "../body/Body";
import DynamicBody from "../body/DynamicBody";
import type Equation from "../equations/Equation";

export interface ConstraintOptions {
  collideConnected?: boolean;
  wakeUpBodies?: boolean;
}

/** Base constraint class. */
export default abstract class Constraint {
  /** Equations to be solved in this constraint */
  equations: Equation[] = [];

  /** First body participating in the constraint. */
  bodyA: Body;

  /** Second body participating in the constraint. */
  bodyB: Body;

  /** Whether the connected bodies should be able to collide with each other. */
  readonly collideConnected: boolean;

  constructor(bodyA: Body, bodyB: Body, options: ConstraintOptions = {}) {
    this.collideConnected = options?.collideConnected ?? true;
    const wakeUpBodies = options?.wakeUpBodies ?? true;

    this.bodyA = bodyA;
    this.bodyB = bodyB;

    // Wake up dynamic bodies when connected
    if (wakeUpBodies) {
      if (bodyA instanceof DynamicBody) {
        bodyA.wakeUp();
      }
      if (bodyB instanceof DynamicBody) {
        bodyB.wakeUp();
      }
    }
  }

  /** Updates the internal constraint parameters before solve. */
  abstract update(): this;

  /** Set stiffness for this constraint. */
  setStiffness(stiffness: number): this {
    const eqs = this.equations;
    for (let i = 0; i !== eqs.length; i++) {
      const eq = eqs[i];
      eq.stiffness = stiffness;
      eq.needsUpdate = true;
    }
    return this;
  }

  /** Set relaxation for this constraint. */
  setRelaxation(relaxation: number): this {
    const eqs = this.equations;
    for (let i = 0; i !== eqs.length; i++) {
      const eq = eqs[i];
      eq.relaxation = relaxation;
      eq.needsUpdate = true;
    }
    return this;
  }
}
