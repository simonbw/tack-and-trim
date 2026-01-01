import { V2d } from "../../../Vector";
import Body from "../../body/Body";
import Box from "../../shapes/Box";
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

/**
 * Collision detection class. Handles all shape-vs-shape collision tests
 * and returns raw collision data (contact points, normals, depths).
 */
export default class CollisionDetector {
  /**
   * Get the collision handler for two shapes using instanceof checks.
   * Returns the handler and whether the shapes need to be swapped.
   */
  getCollisionHandler(
    shapeA: Shape,
    shapeB: Shape
  ): { handler: CollisionHandler; swap: boolean } | null {
    // Circle collisions
    if (shapeA instanceof Circle && shapeB instanceof Circle) {
      return { handler: circleCircle, swap: false };
    }
    if (shapeA instanceof Circle && shapeB instanceof Particle) {
      return { handler: circleParticle, swap: false };
    }
    if (shapeA instanceof Particle && shapeB instanceof Circle) {
      return { handler: circleParticle, swap: true };
    }
    if (shapeA instanceof Circle && shapeB instanceof Plane) {
      return { handler: circlePlane, swap: false };
    }
    if (shapeA instanceof Plane && shapeB instanceof Circle) {
      return { handler: circlePlane, swap: true };
    }
    if (shapeA instanceof Circle && shapeB instanceof Convex) {
      return { handler: circleConvex, swap: false };
    }
    if (shapeA instanceof Convex && shapeB instanceof Circle) {
      return { handler: circleConvex, swap: true };
    }
    if (shapeA instanceof Circle && shapeB instanceof Line) {
      return { handler: circleLine, swap: false };
    }
    if (shapeA instanceof Line && shapeB instanceof Circle) {
      return { handler: circleLine, swap: true };
    }
    if (shapeA instanceof Circle && shapeB instanceof Capsule) {
      return { handler: circleCapsule, swap: false };
    }
    if (shapeA instanceof Capsule && shapeB instanceof Circle) {
      return { handler: circleCapsule, swap: true };
    }
    if (shapeA instanceof Circle && shapeB instanceof Heightfield) {
      return { handler: circleHeightfield, swap: false };
    }
    if (shapeA instanceof Heightfield && shapeB instanceof Circle) {
      return { handler: circleHeightfield, swap: true };
    }

    // Particle collisions
    if (shapeA instanceof Particle && shapeB instanceof Plane) {
      return { handler: particlePlane, swap: false };
    }
    if (shapeA instanceof Plane && shapeB instanceof Particle) {
      return { handler: particlePlane, swap: true };
    }
    if (shapeA instanceof Particle && shapeB instanceof Convex) {
      return { handler: particleConvex, swap: false };
    }
    if (shapeA instanceof Convex && shapeB instanceof Particle) {
      return { handler: particleConvex, swap: true };
    }
    if (shapeA instanceof Particle && shapeB instanceof Capsule) {
      return { handler: particleCapsule, swap: false };
    }
    if (shapeA instanceof Capsule && shapeB instanceof Particle) {
      return { handler: particleCapsule, swap: true };
    }

    // Plane collisions
    if (shapeA instanceof Plane && shapeB instanceof Convex) {
      return { handler: planeConvex, swap: false };
    }
    if (shapeA instanceof Convex && shapeB instanceof Plane) {
      return { handler: planeConvex, swap: true };
    }
    if (shapeA instanceof Plane && shapeB instanceof Line) {
      return { handler: planeLine, swap: false };
    }
    if (shapeA instanceof Line && shapeB instanceof Plane) {
      return { handler: planeLine, swap: true };
    }
    if (shapeA instanceof Plane && shapeB instanceof Capsule) {
      return { handler: planeCapsule, swap: false };
    }
    if (shapeA instanceof Capsule && shapeB instanceof Plane) {
      return { handler: planeCapsule, swap: true };
    }

    // Convex collisions
    if (shapeA instanceof Convex && shapeB instanceof Convex) {
      return { handler: convexConvex, swap: false };
    }
    if (shapeA instanceof Convex && shapeB instanceof Capsule) {
      return { handler: convexCapsule, swap: false };
    }
    if (shapeA instanceof Capsule && shapeB instanceof Convex) {
      return { handler: convexCapsule, swap: true };
    }
    if (shapeA instanceof Convex && shapeB instanceof Heightfield) {
      return { handler: convexHeightfield, swap: false };
    }
    if (shapeA instanceof Heightfield && shapeB instanceof Convex) {
      return { handler: convexHeightfield, swap: true };
    }

    // Capsule collisions
    if (shapeA instanceof Capsule && shapeB instanceof Capsule) {
      return { handler: capsuleCapsule, swap: false };
    }

    // Line collisions (not implemented)
    if (shapeA instanceof Line && shapeB instanceof Line) {
      return { handler: () => null, swap: false };
    }
    if (
      (shapeA instanceof Line && shapeB instanceof Box) ||
      (shapeA instanceof Box && shapeB instanceof Line)
    ) {
      return { handler: () => null, swap: false };
    }
    if (
      (shapeA instanceof Line && shapeB instanceof Capsule) ||
      (shapeA instanceof Capsule && shapeB instanceof Line)
    ) {
      return { handler: () => null, swap: false };
    }
    if (
      (shapeA instanceof Convex && shapeB instanceof Line) ||
      (shapeA instanceof Line && shapeB instanceof Convex)
    ) {
      return { handler: () => null, swap: false };
    }

    return null;
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
    const collision = this.getCollisionHandler(shapeA, shapeB);
    if (!collision) return null;

    const { handler, swap } = collision;
    if (swap) {
      return handler(
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
    } else {
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
}
