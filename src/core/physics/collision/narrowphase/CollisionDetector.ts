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
import { capsuleCapsule } from "./shape-on-shape/CapsuleCollisions";
import {
  circleCapsule,
  circleCircle,
  circleConvex,
  circleHeightfield,
  circleLine,
  circleParticle,
  circlePlane,
} from "./shape-on-shape/CircleCollisions";
import {
  convexCapsule,
  convexConvex,
  convexHeightfield,
} from "./shape-on-shape/ConvexCollisions";
import {
  particleCapsule,
  particleConvex,
  particlePlane,
} from "./shape-on-shape/ParticleCollisions";
import {
  planeCapsule,
  planeConvex,
  planeLine,
} from "./shape-on-shape/PlaneCollisions";

/** Collision handler function type for dispatch */
export type CollisionHandler<T1 = Shape, T2 = Shape> = (
  bodyA: Body,
  shapeA: T1,
  offsetA: V2d,
  angleA: number,
  bodyB: Body,
  shapeB: T2,
  offsetB: V2d,
  angleB: number,
  justTest: boolean
) => CollisionResult | null;

type ShapeConstructor<T extends Shape = Shape> = new (...args: any[]) => T;

/** Wraps a collision handler to swap A and B inputs/outputs. */
function swapped<T1, T2>(
  handler: CollisionHandler<T1, T2>
): CollisionHandler<T2, T1> {
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

// Nested map: ShapeA constructor -> ShapeB constructor -> handler
const handlerRegistry = new Map<
  ShapeConstructor,
  Map<ShapeConstructor, CollisionHandler>
>();

function registerHandler<T1 extends Shape, T2 extends Shape>(
  shapeTypeA: ShapeConstructor<T1>,
  shapeTypeB: ShapeConstructor<T2>,
  handler: CollisionHandler<T1, T2>,
  bidirectional: boolean = true
): void {
  if (!handlerRegistry.has(shapeTypeA)) {
    handlerRegistry.set(shapeTypeA, new Map());
  }
  // Cast is safe: runtime dispatch ensures shapeA/shapeB match T1/T2
  handlerRegistry.get(shapeTypeA)!.set(shapeTypeB, handler as CollisionHandler);

  if (bidirectional && (shapeTypeA as ShapeConstructor) !== shapeTypeB) {
    if (!handlerRegistry.has(shapeTypeB)) {
      handlerRegistry.set(shapeTypeB, new Map());
    }
    handlerRegistry
      .get(shapeTypeB)!
      .set(shapeTypeA, swapped(handler) as CollisionHandler);
  }
}

// Circle collisions
registerHandler(Circle, Circle, circleCircle);
registerHandler(Circle, Particle, circleParticle);
registerHandler(Circle, Plane, circlePlane);
registerHandler(Circle, Convex, circleConvex);
registerHandler(Circle, Line, circleLine);
registerHandler(Circle, Capsule, circleCapsule);
registerHandler(Circle, Heightfield, circleHeightfield);

// Particle collisions
registerHandler(Particle, Plane, particlePlane);
registerHandler(Particle, Convex, particleConvex);
registerHandler(Particle, Capsule, particleCapsule);

// Plane collisions
registerHandler(Plane, Convex, planeConvex);
registerHandler(Plane, Line, planeLine);
registerHandler(Plane, Capsule, planeCapsule);

// Convex collisions
registerHandler(Convex, Convex, convexConvex);
registerHandler(Convex, Capsule, convexCapsule);
registerHandler(Convex, Heightfield, convexHeightfield);

// Capsule collisions
registerHandler(Capsule, Capsule, capsuleCapsule);

function getCollisionHandler(shapeA: Shape, shapeB: Shape): CollisionHandler {
  return (
    handlerRegistry
      .get(shapeA.constructor as ShapeConstructor)
      ?.get(shapeB.constructor as ShapeConstructor) ?? (() => null)
  );
}

/**
 * Test collision between two shapes.
 * Returns collision result or null if no collision.
 *
 * Note: Line-vs-Line, Line-vs-Box, Line-vs-Capsule, and Line-vs-Convex
 * collisions are not implemented.
 */
export function getShapeCollision(
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
  const handler = getCollisionHandler(shapeA, shapeB);
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
