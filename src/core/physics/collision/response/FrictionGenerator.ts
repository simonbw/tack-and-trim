import Body from "../../body/Body";
import ContactEquation from "../../equations/ContactEquation";
import Equation from "../../equations/Equation";
import FrictionEquation from "../../equations/FrictionEquation";
import Shape from "../../shapes/Shape";
import FrictionEquationPool from "../../utils/FrictionEquationPool";

/**
 * Parameters for friction equation generation
 */
export interface FrictionParams {
  /** Whether friction is enabled */
  enabled: boolean;
  /** Maximum friction force before slipping */
  slipForce: number;
  /** Friction coefficient */
  frictionCoefficient: number;
  /** Surface velocity (for conveyor belts, etc.) */
  surfaceVelocity: number;
  /** Whether equations should be enabled */
  equationsEnabled: boolean;
  /** Friction stiffness */
  stiffness: number;
  /** Friction relaxation */
  relaxation: number;
  /** Whether to use friction reduction (averaging multiple contacts) */
  enableFrictionReduction: boolean;
}

/**
 * Default friction parameters
 */
export const DEFAULT_FRICTION_PARAMS: FrictionParams = {
  enabled: true,
  slipForce: 10.0,
  frictionCoefficient: 0.3,
  surfaceVelocity: 0,
  equationsEnabled: true,
  stiffness: Equation.DEFAULT_STIFFNESS,
  relaxation: Equation.DEFAULT_RELAXATION,
  enableFrictionReduction: true,
};

/**
 * Generates FrictionEquation objects from ContactEquation objects.
 * Handles equation pooling, friction reduction, and configuration.
 */
export default class FrictionGenerator {
  private pool: FrictionEquationPool;

  constructor() {
    this.pool = new FrictionEquationPool({ size: 64 });
  }

  /**
   * Generate friction equations from contact equations.
   * If friction reduction is enabled and there are multiple contacts,
   * creates a single averaged friction equation.
   */
  generateFriction(
    contacts: ContactEquation[],
    params: FrictionParams
  ): FrictionEquation[] {
    if (!params.enabled || contacts.length === 0) {
      return [];
    }

    if (params.enableFrictionReduction && contacts.length > 1) {
      // Create a single averaged friction equation
      return [this.createFrictionFromAverage(contacts, params)];
    } else {
      // Create individual friction equations for each contact
      const equations: FrictionEquation[] = [];
      for (const contact of contacts) {
        equations.push(this.createFrictionFromContact(contact, params));
      }
      return equations;
    }
  }

  /**
   * Create a friction equation from a single contact
   */
  createFrictionFromContact(
    contact: ContactEquation,
    params: FrictionParams
  ): FrictionEquation {
    const eq = this.createFrictionEquation(
      contact.bodyA,
      contact.bodyB,
      contact.shapeA!,
      contact.shapeB!,
      params
    );

    eq.contactPointA.set(contact.contactPointA);
    eq.contactPointB.set(contact.contactPointB);
    eq.t.set(contact.normalA).irotate90cw();
    eq.contactEquations.push(contact);

    return eq;
  }

  /**
   * Create an averaged friction equation from multiple contacts
   */
  createFrictionFromAverage(
    contacts: ContactEquation[],
    params: FrictionParams
  ): FrictionEquation {
    const lastContact = contacts[contacts.length - 1];
    const bodyA = lastContact.bodyA;

    const eq = this.createFrictionEquation(
      lastContact.bodyA,
      lastContact.bodyB,
      lastContact.shapeA!,
      lastContact.shapeB!,
      params
    );

    eq.contactPointA.set(0, 0);
    eq.contactPointB.set(0, 0);
    eq.t.set(0, 0);

    for (const contact of contacts) {
      if (contact.bodyA === bodyA) {
        eq.t.iadd(contact.normalA);
        eq.contactPointA.iadd(contact.contactPointA);
        eq.contactPointB.iadd(contact.contactPointB);
      } else {
        eq.t.isub(contact.normalA);
        eq.contactPointA.iadd(contact.contactPointB);
        eq.contactPointB.iadd(contact.contactPointA);
      }
      eq.contactEquations.push(contact);
    }

    const invNumContacts = 1 / contacts.length;
    eq.contactPointA.imul(invNumContacts);
    eq.contactPointB.imul(invNumContacts);
    eq.t.inormalize();
    eq.t.irotate90cw();

    return eq;
  }

  /**
   * Create a base friction equation (without contact point data)
   */
  private createFrictionEquation(
    bodyA: Body,
    bodyB: Body,
    shapeA: Shape,
    shapeB: Shape,
    params: FrictionParams
  ): FrictionEquation {
    const eq = this.pool.get();

    eq.bodyA = bodyA;
    eq.bodyB = bodyB;
    eq.shapeA = shapeA;
    eq.shapeB = shapeB;
    eq.setSlipForce(params.slipForce);
    eq.frictionCoefficient = params.frictionCoefficient;
    eq.relativeVelocity = params.surfaceVelocity;
    eq.enabled = params.equationsEnabled;
    eq.needsUpdate = true;
    eq.stiffness = params.stiffness;
    eq.relaxation = params.relaxation;
    eq.contactEquations.length = 0;

    return eq;
  }

  /**
   * Release friction equations back to the pool
   */
  releaseEquations(equations: FrictionEquation[]): void {
    for (const eq of equations) {
      this.pool.release(eq);
    }
  }
}
