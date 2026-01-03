import { V, V2d } from "../../../../Vector";
import Body from "../../../body/Body";
import Capsule from "../../../shapes/Capsule";
import type Circle from "../../../shapes/Circle";
import Convex from "../../../shapes/Convex";
import Shape from "../../../shapes/Shape";
import { pointInConvex } from "../../CollisionHelpers";
import { CollisionResult, createCollisionResult } from "../../CollisionResult";
import { circleLineOrCapsule } from "./CircleCollisions";

const yAxis = V(0, 1);

/** Particle/Plane collision */
export function particlePlane(
  bodyA: Body,
  _shapeA: Shape,
  offsetA: V2d,
  _angleA: number,
  bodyB: Body,
  _shapeB: Shape,
  offsetB: V2d,
  angleB: number,
  justTest: boolean
): CollisionResult | null {
  // Note: bodyA is particle, bodyB is plane
  const particleToPlane = V(offsetA).isub(offsetB);
  const planeNormal = V(yAxis).irotate(angleB);

  const distance = particleToPlane.dot(planeNormal);

  if (distance > 0) {
    return null;
  }

  if (justTest) {
    return createCollisionResult();
  }

  // Project particle onto plane
  const projectionOffset = V(planeNormal).imul(distance);
  const contactOnPlane = V(offsetA).isub(projectionOffset);

  const result = createCollisionResult();
  // Note: Normal points out of plane (bodyB), so we need to flip for bodyA
  result.contacts.push({
    worldContactA: V(offsetA).isub(bodyA.position),
    worldContactB: V(contactOnPlane).isub(bodyB.position),
    normal: V(planeNormal).imul(-1), // Normal from particle towards plane
    depth: -distance,
  });

  return result;
}

/** Particle/Convex collision */
export function particleConvex(
  bodyA: Body,
  _shapeA: Shape,
  offsetA: V2d,
  _angleA: number,
  bodyB: Body,
  shapeB: Shape,
  offsetB: V2d,
  angleB: number,
  justTest: boolean
): CollisionResult | null {
  // Note: bodyA is particle, bodyB is convex
  const convexShape = shapeB as Convex;
  const verts = convexShape.vertices;

  // Check if particle is inside polygon
  if (!pointInConvex(offsetA, convexShape, offsetB, angleB)) {
    return null;
  }

  if (justTest) {
    return createCollisionResult();
  }

  // Find closest edge
  let minDistance = Number.MAX_VALUE;
  let closestPoint = V();
  let closestNormal = V();

  for (let i = 0; i < verts.length; i++) {
    const v0 = verts[i];
    const v1 = verts[(i + 1) % verts.length];

    // Transform vertices to world
    const worldV0 = V(v0).irotate(angleB).iadd(offsetB);
    const worldV1 = V(v1).irotate(angleB).iadd(offsetB);

    // Get world edge
    const edge = V(worldV1).isub(worldV0);
    const edgeUnit = V(edge).inormalize();

    // Get tangent (points out of the convex)
    const tangent = V(edgeUnit).irotate90cw();

    const vertToParticle = V(worldV0).isub(offsetA);
    const distance = Math.abs(vertToParticle.dot(tangent));

    if (distance < minDistance) {
      minDistance = distance;
      closestPoint.set(tangent).imul(distance).iadd(offsetA);
      closestNormal.set(tangent);
    }
  }

  const result = createCollisionResult();
  result.contacts.push({
    worldContactA: V(offsetA).isub(bodyA.position),
    worldContactB: V(closestPoint).isub(bodyB.position),
    normal: V(closestNormal).imul(-1),
    depth: minDistance,
  });

  return result;
}

/** Particle/Capsule collision */
export function particleCapsule(
  bodyA: Body,
  shapeA: Shape,
  offsetA: V2d,
  angleA: number,
  bodyB: Body,
  shapeB: Capsule,
  offsetB: V2d,
  angleB: number,
  justTest: boolean
): CollisionResult | null {
  const capsuleShape = shapeB as Capsule;
  return circleLineOrCapsule(
    bodyA,
    shapeA as Circle, // pretend particle is a circle of radius 0
    offsetA,
    angleA,
    bodyB,
    shapeB,
    offsetB,
    angleB,
    justTest,
    capsuleShape.radius,
    0
  );
}
