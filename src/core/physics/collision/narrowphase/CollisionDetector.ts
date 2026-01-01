import { V, V2d } from "../../../Vector";
import Body from "../../body/Body";
import Capsule from "../../shapes/Capsule";
import Circle from "../../shapes/Circle";
import Convex from "../../shapes/Convex";
import Heightfield from "../../shapes/Heightfield";
import Line from "../../shapes/Line";
import Particle from "../../shapes/Particle";
import Plane from "../../shapes/Plane";
import Shape from "../../shapes/Shape";
import { CollisionResult } from "../CollisionResult";
import { capsuleCapsule } from "./handlers/CapsuleCollisions";
import {
  circleCapsule,
  circleCircle,
  circleConvex,
  circleHeightfield,
  circleLine,
  circleParticle,
  circlePlane,
} from "./handlers/CircleCollisions";
import {
  convexCapsule,
  convexConvex,
  convexHeightfield,
} from "./handlers/ConvexCollisions";
import {
  particleCapsule,
  particleConvex,
  particlePlane,
} from "./handlers/ParticleCollisions";
import {
  planeCapsule,
  planeConvex,
  planeLine,
} from "./handlers/PlaneCollisions";

/**
 * Collision handler function type for dispatch
 */
export type CollisionHandler = (
  bodyA: Body,
  shapeA: Shape,
  offsetA: V2d,
  angleA: number,
  bodyB: Body,
  shapeB: Shape,
  offsetB: V2d,
  angleB: number,
  justTest: boolean
) => CollisionResult | null;

type ShapeConstructor = new (...args: any[]) => Shape;

/**
 * Wraps a collision handler to swap A and B inputs/outputs.
 */
function swapped(handler: CollisionHandler): CollisionHandler {
  return (
    bodyA,
    shapeA,
    offsetA,
    angleA,
    bodyB,
    shapeB,
    offsetB,
    angleB,
    justTest
  ) => {
    const result = handler(
      bodyB,
      shapeB,
      offsetB,
      angleB,
      bodyA,
      shapeA,
      offsetA,
      angleA,
      justTest
    );
    if (!result) return null;

    // Swap contact points and negate normal
    for (const contact of result.contacts) {
      const temp = contact.worldContactA;
      contact.worldContactA = contact.worldContactB;
      contact.worldContactB = temp;
      contact.normal = V(-contact.normal.x, -contact.normal.y);
    }
    return result;
  };
}

/**
 * Collision detection class. Handles all shape-vs-shape collision tests
 * and returns raw collision data (contact points, normals, depths).
 *
 * Note: Line-vs-Line, Line-vs-Box, Line-vs-Capsule, and Line-vs-Convex
 * collisions are not implemented.
 */
export default class CollisionDetector {
  // Nested map: ShapeA constructor -> ShapeB constructor -> handler
  private handlerRegistry = new Map<
    ShapeConstructor,
    Map<ShapeConstructor, CollisionHandler>
  >();

  constructor() {
    // Circle collisions
    this.registerHandler(Circle, Circle, circleCircle);
    this.registerHandler(Circle, Particle, circleParticle);
    this.registerHandler(Circle, Plane, circlePlane);
    this.registerHandler(Circle, Convex, circleConvex);
    this.registerHandler(Circle, Line, circleLine);
    this.registerHandler(Circle, Capsule, circleCapsule);
    this.registerHandler(Circle, Heightfield, circleHeightfield);

    // Particle collisions
    this.registerHandler(Particle, Plane, particlePlane);
    this.registerHandler(Particle, Convex, particleConvex);
    this.registerHandler(Particle, Capsule, particleCapsule);

    // Plane collisions
    this.registerHandler(Plane, Convex, planeConvex);
    this.registerHandler(Plane, Line, planeLine);
    this.registerHandler(Plane, Capsule, planeCapsule);

    // Convex collisions
    this.registerHandler(Convex, Convex, convexConvex);
    this.registerHandler(Convex, Capsule, convexCapsule);
    this.registerHandler(Convex, Heightfield, convexHeightfield);

    // Capsule collisions
    this.registerHandler(Capsule, Capsule, capsuleCapsule);
  }

  /**
   * Register a collision handler for a pair of shape types.
   * By default, registers both directions (A->B and B->A with swapped inputs/outputs).
   */
  registerHandler(
    shapeA: ShapeConstructor,
    shapeB: ShapeConstructor,
    handler: CollisionHandler,
    bidirectional: boolean = true
  ): void {
    if (!this.handlerRegistry.has(shapeA)) {
      this.handlerRegistry.set(shapeA, new Map());
    }
    this.handlerRegistry.get(shapeA)!.set(shapeB, handler);

    if (bidirectional && shapeA !== shapeB) {
      if (!this.handlerRegistry.has(shapeB)) {
        this.handlerRegistry.set(shapeB, new Map());
      }
      this.handlerRegistry.get(shapeB)!.set(shapeA, swapped(handler));
    }
  }

  /**
   * Get the collision handler for two shapes.
   */
  getCollisionHandler(shapeA: Shape, shapeB: Shape): CollisionHandler {
    const ctorA = shapeA.constructor as ShapeConstructor;
    const ctorB = shapeB.constructor as ShapeConstructor;
    return this.handlerRegistry.get(ctorA)?.get(ctorB) ?? (() => null);
  }

  /**
   * Test collision between two shapes.
   * Returns collision result or null if no collision.
   */
  collide(
    bodyA: Body,
    shapeA: Shape,
    offsetA: V2d,
    angleA: number,
    bodyB: Body,
    shapeB: Shape,
    offsetB: V2d,
    angleB: number,
    justTest: boolean = false
  ): CollisionResult | null {
    const handler = this.getCollisionHandler(shapeA, shapeB);
    return handler(
      bodyA,
      shapeA,
      offsetA,
      angleA,
      bodyB,
      shapeB,
      offsetB,
      angleB,
      justTest
    );
  }
}
