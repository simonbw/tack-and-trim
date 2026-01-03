import { V, V2d } from "../../../../Vector";
import Body from "../../../body/Body";
import Box from "../../../shapes/Box";
import Capsule from "../../../shapes/Capsule";
import Convex from "../../../shapes/Convex";
import Heightfield from "../../../shapes/Heightfield";
import Shape from "../../../shapes/Shape";
import {
  clipSegmentToLine,
  findIncidentEdge,
  findMaxSeparation,
  setCapsuleMiddleRect,
} from "../../CollisionHelpers";
import { CollisionResult, createCollisionResult } from "../../CollisionResult";
import { circleConvex } from "./CircleCollisions";

// Clip points for convex-convex (Box2D style)
const clipPoints1 = [V(), V()];
const clipPoints2 = [V(), V()];
const incidentEdgePoints = [V(), V()];
const maxManifoldPoints = 2;

// Reusable shapes for capsule/heightfield collision
const capsuleMiddleRect = new Box({ width: 1, height: 1 });
const heightfieldTileConvex = new Convex({
  vertices: [V(), V(), V(), V()],
});

/**
 * Convex/Convex collision (SAT with edge clipping)
 */
export function convexConvex(
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
  const polyA = shapeA as Convex;
  const polyB = shapeB as Convex;
  const totalRadius = 0;

  const separationA_out = V();
  const separationB_out = V();

  const edgeA = findMaxSeparation(
    separationA_out,
    polyA,
    offsetA,
    angleA,
    polyB,
    offsetB,
    angleB
  );
  const separationA = separationA_out[0];
  if (separationA > totalRadius) {
    return null;
  }

  const edgeB = findMaxSeparation(
    separationB_out,
    polyB,
    offsetB,
    angleB,
    polyA,
    offsetA,
    angleA
  );
  const separationB = separationB_out[0];
  if (separationB > totalRadius) {
    return null;
  }

  let poly1: Convex;
  let poly2: Convex;
  let position1: V2d;
  let position2: V2d;
  let angle1: number;
  let angle2: number;
  let body1: Body;
  let body2: Body;
  let edge1: number;

  if (separationB > separationA) {
    poly1 = polyB;
    poly2 = polyA;
    body1 = bodyB;
    body2 = bodyA;
    position1 = offsetB;
    angle1 = angleB;
    position2 = offsetA;
    angle2 = angleA;
    edge1 = edgeB;
  } else {
    poly1 = polyA;
    poly2 = polyB;
    body1 = bodyA;
    body2 = bodyB;
    position1 = offsetA;
    angle1 = angleA;
    position2 = offsetB;
    angle2 = angleB;
    edge1 = edgeA;
  }

  findIncidentEdge(
    incidentEdgePoints,
    poly1,
    position1,
    angle1,
    edge1,
    poly2,
    position2,
    angle2
  );

  const count1 = poly1.vertices.length;
  const vertices1 = poly1.vertices;

  const iv1 = edge1;
  const iv2 = edge1 + 1 < count1 ? edge1 + 1 : 0;

  const v11 = V(vertices1[iv1]);
  const v12 = V(vertices1[iv2]);

  const localTangent = V(v12).isub(v11).inormalize();
  const localNormal = V(localTangent).icrossVZ(1.0);

  const planePoint = V(v11).iadd(v12).imul(0.5);

  const tangent = V(localTangent).irotate(angle1);
  const normal = V(tangent).icrossVZ(1.0);

  v11.itoGlobalFrame(position1, angle1);
  v12.itoGlobalFrame(position1, angle1);

  // Face offset
  const frontOffset = normal.dot(v11);

  // Side offsets
  const sideOffset1 = -tangent.dot(v11) + totalRadius;
  const sideOffset2 = tangent.dot(v12) + totalRadius;

  // Clip incident edge
  const negativeTangent = V(tangent).imul(-1);
  let np = clipSegmentToLine(
    clipPoints1,
    incidentEdgePoints,
    negativeTangent,
    sideOffset1
  );

  if (np < 2) {
    return null;
  }

  np = clipSegmentToLine(clipPoints2, clipPoints1, tangent, sideOffset2);

  if (np < 2) {
    return null;
  }

  const result = createCollisionResult();

  for (let i = 0; i < maxManifoldPoints; i++) {
    const separation = normal.dot(clipPoints2[i]) - frontOffset;

    if (separation <= totalRadius) {
      if (justTest) {
        return createCollisionResult();
      }

      const contactPointOnPoly2 = V(clipPoints2[i]);
      const dist = V(normal).imul(-separation);
      const contactPointOnPoly1 = V(clipPoints2[i]).iadd(dist);

      result.contacts.push({
        worldContactA: V(contactPointOnPoly1).isub(body1.position),
        worldContactB: V(contactPointOnPoly2).isub(body2.position),
        normal: V(normal),
        depth: -separation,
      });
    }
  }

  if (result.contacts.length === 0) {
    return null;
  }

  // If bodies were swapped, swap the result back
  if (separationB > separationA) {
    for (const contact of result.contacts) {
      const temp = contact.worldContactA;
      contact.worldContactA = contact.worldContactB;
      contact.worldContactB = temp;
      contact.normal.imul(-1);
    }
  }

  return result;
}

/**
 * Convex/Capsule collision
 */
export function convexCapsule(
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
  const convexShape = shapeA as Convex;
  const capsuleShape = shapeB as Capsule;
  const halfLength = capsuleShape.length / 2;

  // Check the end circles
  const circlePos1 = V(halfLength, 0).itoGlobalFrame(offsetB, angleB);
  const result1 = circleConvex(
    bodyB,
    capsuleShape,
    circlePos1,
    angleB,
    bodyA,
    convexShape,
    offsetA,
    angleA,
    justTest,
    capsuleShape.radius
  );

  const circlePos2 = V(-halfLength, 0).itoGlobalFrame(offsetB, angleB);
  const result2 = circleConvex(
    bodyB,
    capsuleShape,
    circlePos2,
    angleB,
    bodyA,
    convexShape,
    offsetA,
    angleA,
    justTest,
    capsuleShape.radius
  );

  if (justTest && (result1 || result2)) {
    return createCollisionResult();
  }

  // Check center rect
  setCapsuleMiddleRect(capsuleMiddleRect, capsuleShape);
  const result3 = convexConvex(
    bodyA,
    convexShape,
    offsetA,
    angleA,
    bodyB,
    capsuleMiddleRect,
    offsetB,
    angleB,
    justTest
  );

  if (!result1 && !result2 && !result3) {
    return null;
  }

  if (justTest) {
    return createCollisionResult();
  }

  // Combine results, swapping contacts from circle-convex tests
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
  if (result3) {
    result.contacts.push(...result3.contacts);
  }

  return result;
}

/**
 * Convex/Heightfield collision
 */
export function convexHeightfield(
  bodyA: Body,
  shapeA: Shape,
  offsetA: V2d,
  angleA: number,
  bodyB: Body,
  shapeB: Shape,
  offsetB: V2d,
  _angleB: number,
  justTest: boolean
): CollisionResult | null {
  const convexShape = shapeA as Convex;
  const hfShape = shapeB as Heightfield;

  const data = hfShape.heights;
  const w = hfShape.elementWidth;

  // Use body's AABB to get index range
  const aabb = bodyA.aabb;
  let idxA = Math.floor((aabb.lowerBound[0] - offsetB[0]) / w);
  let idxB = Math.ceil((aabb.upperBound[0] - offsetB[0]) / w);

  if (idxA < 0) idxA = 0;
  if (idxB >= data.length) idxB = data.length - 1;

  // Get max height in range
  let max = data[idxA];
  for (let i = idxA; i < idxB; i++) {
    if (data[i] > max) max = data[i];
  }

  if (aabb.lowerBound[1] > max + offsetB[1]) {
    return null;
  }

  const result = createCollisionResult();

  // Loop over all edges
  for (let i = idxA; i < idxB; i++) {
    const v0 = V(i * w + offsetB[0], data[i] + offsetB[1]);
    const v1 = V((i + 1) * w + offsetB[0], data[i + 1] + offsetB[1]);

    // Construct a convex tile
    const tileHeight = 100;
    const tilePos = V(
      (v1[0] + v0[0]) * 0.5,
      (v1[1] + v0[1] - tileHeight) * 0.5
    );

    heightfieldTileConvex.vertices[0].set(v1).isub(tilePos);
    heightfieldTileConvex.vertices[1].set(v0).isub(tilePos);
    heightfieldTileConvex.vertices[2].set(heightfieldTileConvex.vertices[1]);
    heightfieldTileConvex.vertices[3].set(heightfieldTileConvex.vertices[0]);
    heightfieldTileConvex.vertices[2][1] -= tileHeight;
    heightfieldTileConvex.vertices[3][1] -= tileHeight;

    // Update normals for the tile
    for (let j = 0; j < 4; j++) {
      const v0j = heightfieldTileConvex.vertices[j];
      const v1j = heightfieldTileConvex.vertices[(j + 1) % 4];
      heightfieldTileConvex.axes[j].set(v1j).isub(v0j);
      heightfieldTileConvex.axes[j].irotate90cw();
      heightfieldTileConvex.axes[j].inormalize();
    }

    // Do convex collision
    const tileResult = convexConvex(
      bodyA,
      convexShape,
      offsetA,
      angleA,
      bodyB,
      heightfieldTileConvex,
      tilePos,
      0,
      justTest
    );

    if (justTest && tileResult) {
      return createCollisionResult();
    }

    if (tileResult) {
      result.contacts.push(...tileResult.contacts);
    }
  }

  if (result.contacts.length === 0) {
    return null;
  }

  return result;
}
