import vec2, { Vec2 } from "../math/vec2";
import ContactEquationPool from "../utils/ContactEquationPool";
import FrictionEquationPool from "../utils/FrictionEquationPool";
import TupleDictionary from "../utils/TupleDictionary";
import Equation from "../equations/Equation";
import ContactEquation from "../equations/ContactEquation";
import FrictionEquation from "../equations/FrictionEquation";
import Shape from "../shapes/Shape";
import Body from "../objects/Body";
import type World from "../world/World";

// Module-level temp vectors
const bodiesOverlap_shapePositionA = vec2.create();
const bodiesOverlap_shapePositionB = vec2.create();

/**
 * Narrowphase. Creates contacts and friction given shapes and transforms.
 */
export default class Narrowphase {
  contactEquations: ContactEquation[] = [];
  frictionEquations: FrictionEquation[] = [];
  enableFriction: boolean = true;
  enabledEquations: boolean = true;
  slipForce: number = 10.0;
  frictionCoefficient: number = 0.3;
  surfaceVelocity: number = 0;
  contactEquationPool: ContactEquationPool;
  frictionEquationPool: FrictionEquationPool;
  restitution: number = 0;
  stiffness: number;
  relaxation: number;
  frictionStiffness: number;
  frictionRelaxation: number;
  enableFrictionReduction: boolean = true;
  collidingBodiesLastStep: TupleDictionary;
  contactSkinSize: number = 0.01;
  world!: World;

  // Collision method lookup indexed by shape type combination
  [key: number]: any;

  constructor(world?: World) {
    if (world) {
      this.world = world;
    }
    this.contactEquationPool = new ContactEquationPool({ size: 32 });
    this.frictionEquationPool = new FrictionEquationPool({ size: 64 });
    this.stiffness = Equation.DEFAULT_STIFFNESS;
    this.relaxation = Equation.DEFAULT_RELAXATION;
    this.frictionStiffness = Equation.DEFAULT_STIFFNESS;
    this.frictionRelaxation = Equation.DEFAULT_RELAXATION;
    this.collidingBodiesLastStep = new TupleDictionary();
  }

  /**
   * Check if bodies overlap.
   */
  bodiesOverlap(bodyA: Body, bodyB: Body): boolean {
    const shapePositionA = bodiesOverlap_shapePositionA;
    const shapePositionB = bodiesOverlap_shapePositionB;

    // Loop over all shapes of bodyA
    for (let k = 0, Nshapesi = bodyA.shapes.length; k !== Nshapesi; k++) {
      const shapeA = bodyA.shapes[k];
      bodyA.toWorldFrame(shapePositionA, shapeA.position);

      // All shapes of bodyB
      for (let l = 0, Nshapesj = bodyB.shapes.length; l !== Nshapesj; l++) {
        const shapeB = bodyB.shapes[l];
        bodyB.toWorldFrame(shapePositionB, shapeB.position);

        // Get the collision test function for these shape types
        const collisionFn = this[shapeA.type | shapeB.type];
        if (collisionFn) {
          const result = collisionFn.call(
            this,
            bodyA,
            shapeA,
            shapePositionA,
            shapeA.angle + bodyA.angle,
            bodyB,
            shapeB,
            shapePositionB,
            shapeB.angle + bodyB.angle,
            true // justTest - just check for overlap, don't create equations
          );
          if (result) {
            return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * Reset the narrowphase.
   */
  reset(): void {
    // Release contact equations back to pool
    while (this.contactEquations.length) {
      const eq = this.contactEquations.pop()!;
      this.contactEquationPool.release(eq);
    }

    // Release friction equations back to pool
    while (this.frictionEquations.length) {
      const eq = this.frictionEquations.pop()!;
      this.frictionEquationPool.release(eq);
    }
  }

  /**
   * Creates a ContactEquation, either by reusing an existing object or creating a new one.
   */
  createContactEquation(
    bodyA: Body,
    bodyB: Body,
    shapeA: Shape,
    shapeB: Shape
  ): ContactEquation {
    const c = this.contactEquationPool.get();
    c.bodyA = bodyA;
    c.bodyB = bodyB;
    c.shapeA = shapeA;
    c.shapeB = shapeB;
    c.restitution = this.restitution;
    c.firstImpact = !this.collidingBodiesLastStep.get(bodyA.id, bodyB.id);
    c.stiffness = this.stiffness;
    c.relaxation = this.relaxation;
    c.needsUpdate = true;
    c.enabled = this.enabledEquations;
    c.offset = this.contactSkinSize;
    return c;
  }

  /**
   * Creates a FrictionEquation, either by reusing an existing object or creating a new one.
   */
  createFrictionEquation(
    bodyA: Body,
    bodyB: Body,
    shapeA: Shape,
    shapeB: Shape
  ): FrictionEquation {
    const c = this.frictionEquationPool.get();
    c.bodyA = bodyA;
    c.bodyB = bodyB;
    c.shapeA = shapeA;
    c.shapeB = shapeB;
    c.setSlipForce(this.slipForce);
    c.frictionCoefficient = this.frictionCoefficient;
    c.relativeVelocity = this.surfaceVelocity;
    c.enabled = this.enabledEquations;
    c.needsUpdate = true;
    c.stiffness = this.frictionStiffness;
    c.relaxation = this.frictionRelaxation;
    c.contactEquations.length = 0;
    return c;
  }

  // Collision detection methods - these are stubs that should be overridden
  // by the actual implementation (e.g., CustomNarrowphase)
  // The hitTest method in World uses these methods

  /**
   * Circle/Particle collision
   */
  circleParticle(
    _bodyA: Body,
    _shapeA: Shape,
    _posA: Vec2,
    _angleA: number,
    _bodyB: Body,
    _shapeB: Shape,
    _posB: Vec2,
    _angleB: number,
    _justTest?: boolean
  ): number {
    return 0;
  }

  /**
   * Particle/Convex collision
   */
  particleConvex(
    _bodyA: Body,
    _shapeA: Shape,
    _posA: Vec2,
    _angleA: number,
    _bodyB: Body,
    _shapeB: Shape,
    _posB: Vec2,
    _angleB: number,
    _justTest?: boolean
  ): number {
    return 0;
  }

  /**
   * Particle/Plane collision
   */
  particlePlane(
    _bodyA: Body,
    _shapeA: Shape,
    _posA: Vec2,
    _angleA: number,
    _bodyB: Body,
    _shapeB: Shape,
    _posB: Vec2,
    _angleB: number,
    _justTest?: boolean
  ): number {
    return 0;
  }

  /**
   * Particle/Capsule collision
   */
  particleCapsule(
    _bodyA: Body,
    _shapeA: Shape,
    _posA: Vec2,
    _angleA: number,
    _bodyB: Body,
    _shapeB: Shape,
    _posB: Vec2,
    _angleB: number,
    _justTest?: boolean
  ): number {
    return 0;
  }
}
