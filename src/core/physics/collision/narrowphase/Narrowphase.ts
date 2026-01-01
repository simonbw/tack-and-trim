import { V2d } from "../../../Vector";
import Body from "../../body/Body";
import ContactEquation from "../../equations/ContactEquation";
import Equation from "../../equations/Equation";
import FrictionEquation from "../../equations/FrictionEquation";
import Shape from "../../shapes/Shape";
import type World from "../../world/World";
import ContactGenerator, { ContactParams } from "../response/ContactGenerator";
import FrictionGenerator, {
  FrictionParams,
} from "../response/FrictionGenerator";
import CollisionDetector from "./CollisionDetector";

/**
 * Narrowphase. Creates contacts and friction given shapes and transforms.
 *
 * This class coordinates three subsystems:
 * - CollisionDetector: Handles all shape-vs-shape collision tests
 * - ContactGenerator: Creates ContactEquation objects from collision data
 * - FrictionGenerator: Creates FrictionEquation objects from contacts
 */
export default class Narrowphase {
  /** Generated contact equations from the last collision pass */
  contactEquations: ContactEquation[] = [];

  /** Generated friction equations from the last collision pass */
  frictionEquations: FrictionEquation[] = [];

  /** Whether friction is enabled globally */
  enableFriction: boolean = true;

  /** Whether generated equations should be enabled */
  enabledEquations: boolean = true;

  /** Maximum friction force before slipping */
  slipForce: number = 10.0;

  /** Friction coefficient */
  frictionCoefficient: number = 0.3;

  /** Surface velocity for conveyor-belt-like effects */
  surfaceVelocity: number = 0;

  /** Restitution (bounciness) coefficient */
  restitution: number = 0;

  /** Contact stiffness */
  stiffness: number;

  /** Contact relaxation */
  relaxation: number;

  /** Friction stiffness */
  frictionStiffness: number;

  /** Friction relaxation */
  frictionRelaxation: number;

  /** Whether to use friction reduction (averaging multiple contacts) */
  enableFrictionReduction: boolean = true;

  /** Contact skin size (offset) */
  contactSkinSize: number = 0.01;

  /** Reference to the physics world */
  world!: World;

  // Subsystems
  private collisionDetector: CollisionDetector;
  private contactGenerator: ContactGenerator;
  private frictionGenerator: FrictionGenerator;

  constructor(world?: World) {
    if (world) {
      this.world = world;
    }

    this.stiffness = Equation.DEFAULT_STIFFNESS;
    this.relaxation = Equation.DEFAULT_RELAXATION;
    this.frictionStiffness = Equation.DEFAULT_STIFFNESS;
    this.frictionRelaxation = Equation.DEFAULT_RELAXATION;

    // Initialize subsystems
    this.collisionDetector = new CollisionDetector();
    this.contactGenerator = new ContactGenerator();
    this.frictionGenerator = new FrictionGenerator();
  }

  /**
   * Get current contact parameters
   */
  private getContactParams(): ContactParams {
    return {
      restitution: this.restitution,
      stiffness: this.stiffness,
      relaxation: this.relaxation,
      enabled: this.enabledEquations,
      contactSkinSize: this.contactSkinSize,
    };
  }

  /**
   * Get current friction parameters
   */
  private getFrictionParams(): FrictionParams {
    return {
      enabled: this.enableFriction,
      slipForce: this.slipForce,
      frictionCoefficient: this.frictionCoefficient,
      surfaceVelocity: this.surfaceVelocity,
      equationsEnabled: this.enabledEquations,
      stiffness: this.frictionStiffness,
      relaxation: this.frictionRelaxation,
      enableFrictionReduction: this.enableFrictionReduction,
    };
  }

  /**
   * Check if bodies overlap (for testing only, doesn't generate equations)
   */
  bodiesOverlap(bodyA: Body, bodyB: Body): boolean {
    for (const shapeA of bodyA.shapes) {
      const shapePositionA = bodyA.toWorldFrame(shapeA.position);

      for (const shapeB of bodyB.shapes) {
        const shapePositionB = bodyB.toWorldFrame(shapeB.position);

        const result = this.collisionDetector.collide(
          bodyA,
          shapeA,
          shapePositionA,
          shapeA.angle + bodyA.angle,
          bodyB,
          shapeB,
          shapePositionB,
          shapeB.angle + bodyB.angle,
          true // justTest
        );

        if (result) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Check if bodies were colliding in the previous step
   */
  collidedLastStep(bodyA: Body, bodyB: Body): boolean {
    return this.contactGenerator.collidedLastStep(bodyA, bodyB);
  }

  /**
   * Reset the narrowphase. Releases all equations back to pools.
   */
  reset(): void {
    // Update tracking of colliding bodies before clearing
    this.contactGenerator.updateCollidingBodies(this.contactEquations);

    // Release contact equations back to pool
    this.contactGenerator.releaseEquations(this.contactEquations);
    this.contactEquations.length = 0;

    // Release friction equations back to pool
    this.frictionGenerator.releaseEquations(this.frictionEquations);
    this.frictionEquations.length = 0;
  }

  /**
   * Collide two shapes and generate contact/friction equations
   */
  collideShapes(
    bodyA: Body,
    shapeA: Shape,
    offsetA: V2d,
    angleA: number,
    bodyB: Body,
    shapeB: Shape,
    offsetB: V2d,
    angleB: number
  ): number {
    // Detect collision
    const collision = this.collisionDetector.collide(
      bodyA,
      shapeA,
      offsetA,
      angleA,
      bodyB,
      shapeB,
      offsetB,
      angleB,
      false // generate full result
    );

    if (!collision || collision.contacts.length === 0) {
      return 0;
    }

    // Generate contact equations
    const contacts = this.contactGenerator.generateContacts(
      collision,
      bodyA,
      shapeA,
      bodyB,
      shapeB,
      this.getContactParams()
    );

    this.contactEquations.push(...contacts);

    // Generate friction equations
    const friction = this.frictionGenerator.generateFriction(
      contacts,
      this.getFrictionParams()
    );

    this.frictionEquations.push(...friction);

    return contacts.length;
  }
}
