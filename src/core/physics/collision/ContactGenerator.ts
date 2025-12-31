import { V2d } from "../../Vector";
import Body from "../body/Body";
import ContactEquation from "../equations/ContactEquation";
import Equation from "../equations/Equation";
import Shape from "../shapes/Shape";
import ContactEquationPool from "../utils/ContactEquationPool";
import TupleDictionary from "../utils/TupleDictionary";
import { CollisionResult } from "./CollisionResult";

/**
 * Parameters for contact equation generation
 */
export interface ContactParams {
  /** Restitution (bounciness) coefficient (0 = no bounce, 1 = max bounce) */
  restitution: number;
  /** Contact stiffness */
  stiffness: number;
  /** Contact relaxation */
  relaxation: number;
  /** Whether equations should be enabled */
  enabled: boolean;
  /** Contact skin size (offset) */
  contactSkinSize: number;
}

/**
 * Default contact parameters
 */
export const DEFAULT_CONTACT_PARAMS: ContactParams = {
  restitution: 0,
  stiffness: Equation.DEFAULT_STIFFNESS,
  relaxation: Equation.DEFAULT_RELAXATION,
  enabled: true,
  contactSkinSize: 0.01,
};

/**
 * Generates ContactEquation objects from collision detection results.
 * Handles equation pooling and configuration.
 */
export default class ContactGenerator {
  private pool: ContactEquationPool;

  /** Tracks which body pairs were colliding in the previous step */
  collidingBodiesLastStep: TupleDictionary;

  constructor() {
    this.pool = new ContactEquationPool({ size: 32 });
    this.collidingBodiesLastStep = new TupleDictionary();
  }

  /**
   * Generate contact equations from a collision result
   */
  generateContacts(
    collision: CollisionResult,
    bodyA: Body,
    shapeA: Shape,
    bodyB: Body,
    shapeB: Shape,
    params: ContactParams
  ): ContactEquation[] {
    const equations: ContactEquation[] = [];

    for (const contact of collision.contacts) {
      const eq = this.createContactEquation(
        bodyA,
        bodyB,
        shapeA,
        shapeB,
        contact.worldContactA,
        contact.worldContactB,
        contact.normal,
        params
      );
      equations.push(eq);
    }

    return equations;
  }

  /**
   * Create a single ContactEquation from collision data
   */
  private createContactEquation(
    bodyA: Body,
    bodyB: Body,
    shapeA: Shape,
    shapeB: Shape,
    contactPointA: V2d,
    contactPointB: V2d,
    normal: V2d,
    params: ContactParams
  ): ContactEquation {
    const c = this.pool.get();

    c.bodyA = bodyA;
    c.bodyB = bodyB;
    c.shapeA = shapeA;
    c.shapeB = shapeB;
    c.restitution = params.restitution;
    c.firstImpact = !this.collidingBodiesLastStep.get(bodyA.id, bodyB.id);
    c.stiffness = params.stiffness;
    c.relaxation = params.relaxation;
    c.needsUpdate = true;
    c.enabled = params.enabled;
    c.offset = params.contactSkinSize;

    // Set contact data
    c.normalA.set(normal);
    c.contactPointA.set(contactPointA);
    c.contactPointB.set(contactPointB);

    return c;
  }

  /**
   * Update tracking of colliding bodies for the next step
   */
  updateCollidingBodies(contactEquations: ContactEquation[]): void {
    this.collidingBodiesLastStep.reset();
    for (const eq of contactEquations) {
      this.collidingBodiesLastStep.set(eq.bodyA.id, eq.bodyB.id, true);
    }
  }

  /**
   * Check if bodies were colliding in the previous step
   */
  collidedLastStep(bodyA: Body, bodyB: Body): boolean {
    return !!this.collidingBodiesLastStep.get(bodyA.id, bodyB.id);
  }

  /**
   * Release contact equations back to the pool
   */
  releaseEquations(equations: ContactEquation[]): void {
    for (const eq of equations) {
      this.pool.release(eq);
    }
  }
}
