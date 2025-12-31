import type Body from "../body/Body";
import type Equation from "../equations/Equation";

export interface ConstraintOptions {
  collideConnected?: boolean;
  wakeUpBodies?: boolean;
}

/**
 * Base constraint class.
 */
export default class Constraint {
  /**
   * Equations to be solved in this constraint
   */
  equations: Equation[] = [];

  /**
   * First body participating in the constraint.
   */
  bodyA: Body;

  /**
   * Second body participating in the constraint.
   */
  bodyB: Body;

  /**
   * Set to true if you want the connected bodies to collide.
   */
  collideConnected: boolean;

  constructor(bodyA: Body, bodyB: Body, options: ConstraintOptions = {}) {
    const collideConnected = options?.collideConnected ?? true;
    const wakeUpBodies = options?.wakeUpBodies ?? true;

    this.bodyA = bodyA;
    this.bodyB = bodyB;
    this.collideConnected = collideConnected;

    // Wake up bodies when connected
    if (wakeUpBodies) {
      if (bodyA) {
        bodyA.wakeUp();
      }
      if (bodyB) {
        bodyB.wakeUp();
      }
    }
  }

  /**
   * Updates the internal constraint parameters before solve.
   */
  update(): this {
    throw new Error(
      "method update() not implemented in this Constraint subclass!"
    );
  }

  /**
   * Set stiffness for this constraint.
   */
  setStiffness(stiffness: number): this {
    const eqs = this.equations;
    for (let i = 0; i !== eqs.length; i++) {
      const eq = eqs[i];
      eq.stiffness = stiffness;
      eq.needsUpdate = true;
    }
    return this;
  }

  /**
   * Set relaxation for this constraint.
   */
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
