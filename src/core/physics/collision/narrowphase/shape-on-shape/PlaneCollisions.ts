import { V, V2d } from "../../../../Vector";
import Body from "../../../body/Body";
import Capsule from "../../../shapes/Capsule";
import Circle from "../../../shapes/Circle";
import Convex from "../../../shapes/Convex";
import Line from "../../../shapes/Line";
import Shape from "../../../shapes/Shape";
import { CollisionResult, createCollisionResult } from "../../CollisionResult";
import { circlePlane } from "./CircleCollisions";

const yAxis = V(0, 1);
const tempCircle = new Circle({ radius: 1 });

/** Plane/Line collision */
export function planeLine(
  bodyA: Body,
  _shapeA: Shape,
  offsetA: V2d,
  angleA: number,
  bodyB: Body,
  shapeB: Shape,
  offsetB: V2d,
  angleB: number,
  justTest: boolean
): CollisionResult | null {
  // Note: bodyA is plane, bodyB is line
  const lineShape = shapeB as Line;
  const halfLength = lineShape.length / 2;

  // Get line endpoints
  const lineStart = V(-halfLength, 0).itoGlobalFrame(offsetB, angleB);
  const lineEnd = V(halfLength, 0).itoGlobalFrame(offsetB, angleB);

  const planeNormal = V(yAxis).irotate(angleA);

  const result = createCollisionResult();

  // Check line endpoints against plane
  const endpoints = [lineStart, lineEnd];
  for (const endpoint of endpoints) {
    const dist = V(endpoint).isub(offsetA);
    const distance = dist.dot(planeNormal);

    if (distance < 0) {
      if (justTest) {
        return createCollisionResult();
      }

      // Project endpoint onto plane
      const projectionOffset = V(planeNormal).imul(distance);
      const contactOnPlane = V(endpoint).isub(projectionOffset);

      result.contacts.push({
        worldContactA: V(contactOnPlane).isub(bodyA.position),
        worldContactB: V(endpoint).isub(bodyB.position),
        normal: V(planeNormal),
        depth: -distance,
      });
    }
  }

  if (result.contacts.length === 0) {
    return null;
  }

  return result;
}

/** Plane/Capsule collision */
export function planeCapsule(
  bodyA: Body,
  shapeA: Shape,
  offsetA: V2d,
  angleA: number,
  bodyB: Body,
  shapeB: Shape,
  offsetB: V2d,
  angleB: number,
  justTest: boolean
): CollisionResult | null {
  // Note: bodyA is plane, bodyB is capsule
  const capsuleShape = shapeB as Capsule;
  const halfLength = capsuleShape.length / 2;

  // Compute world end positions
  const end1 = V(-halfLength, 0).itoGlobalFrame(offsetB, angleB);
  const end2 = V(halfLength, 0).itoGlobalFrame(offsetB, angleB);

  tempCircle.radius = capsuleShape.radius;

  // Check both ends against the plane
  const result1 = circlePlane(
    bodyB,
    tempCircle,
    end1,
    0,
    bodyA,
    shapeA,
    offsetA,
    angleA,
    justTest
  );

  const result2 = circlePlane(
    bodyB,
    tempCircle,
    end2,
    0,
    bodyA,
    shapeA,
    offsetA,
    angleA,
    justTest
  );

  if (!result1 && !result2) {
    return null;
  }

  if (justTest) {
    return createCollisionResult();
  }

  // Combine results, swapping A and B since we called with swapped order
  const result = createCollisionResult();
  if (result1) {
    for (const contact of result1.contacts) {
      result.contacts.push({
        worldContactA: contact.worldContactB,
        worldContactB: contact.worldContactA,
        normal: V(contact.normal).imul(-1),
        depth: contact.depth,
      });
    }
  }
  if (result2) {
    for (const contact of result2.contacts) {
      result.contacts.push({
        worldContactA: contact.worldContactB,
        worldContactB: contact.worldContactA,
        normal: V(contact.normal).imul(-1),
        depth: contact.depth,
      });
    }
  }

  return result;
}

/** Plane/Convex collision */
export function planeConvex(
  bodyA: Body,
  _shapeA: Shape,
  offsetA: V2d,
  angleA: number,
  bodyB: Body,
  shapeB: Shape,
  offsetB: V2d,
  angleB: number,
  justTest: boolean
): CollisionResult | null {
  // Note: bodyA is plane, bodyB is convex
  const convexShape = shapeB as Convex;
  const planeNormal = V(yAxis).irotate(angleA);

  // Get convex-local plane offset and normal
  const localPlaneNormal = V(planeNormal).irotate(-angleB);
  const localPlaneOffset = V(offsetA).itoLocalFrame(offsetB, angleB);

  const result = createCollisionResult();
  const vertices = convexShape.vertices;

  for (const v of vertices) {
    const localDist = V(v).isub(localPlaneOffset);

    if (localDist.dot(localPlaneNormal) <= 0) {
      if (justTest) {
        return createCollisionResult();
      }

      const worldVertex = V(v).itoGlobalFrame(offsetB, angleB);
      const dist = V(worldVertex).isub(offsetA);
      const d = dist.dot(planeNormal);
      const projectionOffset = V(planeNormal).imul(d);
      const contactOnPlane = V(worldVertex).isub(projectionOffset);

      result.contacts.push({
        worldContactA: V(contactOnPlane).isub(bodyA.position),
        worldContactB: V(worldVertex).isub(bodyB.position),
        normal: V(planeNormal),
        depth: -d,
      });
    }
  }

  if (result.contacts.length === 0) {
    return null;
  }

  return result;
}
