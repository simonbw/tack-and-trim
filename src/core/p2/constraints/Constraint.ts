import { defaults } from "../utils/Utils";
import type Body from "../objects/Body";
import type Equation from "../equations/Equation";

export interface ConstraintOptions {
  collideConnected?: boolean;
  wakeUpBodies?: boolean;
}

/**
 * Base constraint class.
 */
export default class Constraint {
  // Constraint type constants
  static readonly DISTANCE = 1;
  static readonly GEAR = 2;
  static readonly LOCK = 3;
  static readonly PRISMATIC = 4;
  static readonly REVOLUTE = 5;

  /**
   * The type of constraint. May be one of Constraint.DISTANCE, Constraint.GEAR,
   * Constraint.LOCK, Constraint.PRISMATIC or Constraint.REVOLUTE.
   */
  type: number;

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

  constructor(
    bodyA: Body,
    bodyB: Body,
    type?: number,
    options: ConstraintOptions = {}
  ) {
    this.type = type ?? 0;

    const opts = defaults(options, {
      collideConnected: true,
      wakeUpBodies: true,
    });

    this.bodyA = bodyA;
    this.bodyB = bodyB;
    this.collideConnected = opts.collideConnected;

    // Wake up bodies when connected
    if (opts.wakeUpBodies) {
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
  update(): void {
    throw new Error(
      "method update() not implemented in this Constraint subclass!"
    );
  }

  /**
   * Set stiffness for this constraint.
   */
  setStiffness(stiffness: number): void {
    const eqs = this.equations;
    for (let i = 0; i !== eqs.length; i++) {
      const eq = eqs[i];
      eq.stiffness = stiffness;
      eq.needsUpdate = true;
    }
  }

  /**
   * Set relaxation for this constraint.
   */
  setRelaxation(relaxation: number): void {
    const eqs = this.equations;
    for (let i = 0; i !== eqs.length; i++) {
      const eq = eqs[i];
      eq.relaxation = relaxation;
      eq.needsUpdate = true;
    }
  }
}
