import { V, V2d } from "../../../../Vector";
import Body from "../../../body/Body";
import Capsule from "../../../shapes/Capsule";
import Circle from "../../../shapes/Circle";
import Convex from "../../../shapes/Convex";
import Heightfield from "../../../shapes/Heightfield";
import Line from "../../../shapes/Line";
import Particle from "../../../shapes/Particle";
import Plane from "../../../shapes/Plane";
import Shape from "../../../shapes/Shape";
import { pointInConvexLocal } from "../../CollisionHelpers";
import { CollisionResult, createCollisionResult } from "../../CollisionResult";

const yAxis = V(0, 1);

/** Circle/Circle collision */
export function circleCircle(
  bodyA: Body,
  shapeA: Circle,
  offsetA: V2d,
  _angleA: number,
  bodyB: Body,
  shapeB: Circle,
  offsetB: V2d,
  _angleB: number,
  justTest: boolean,
  radiusA?: number,
  radiusB?: number
): CollisionResult | null {
  const circleA = shapeA as Circle;
  const circleB = shapeB as Circle;
  const rA = radiusA ?? circleA.radius;
  const rB = radiusB ?? circleB.radius;

  const centerDiff = V(offsetA).isub(offsetB);
  const radiusSum = rA + rB;

  if (centerDiff.squaredMagnitude > radiusSum * radiusSum) {
    return null;
  }

  if (justTest) {
    return createCollisionResult();
  }

  // Compute normal from A to B
  const normal = V(offsetB).isub(offsetA);
  normal.inormalize();

  // Contact point on circle A surface (world space)
  const contactOnA = V(normal).imul(rA).iadd(offsetA);
  // Contact point on circle B surface (world space)
  const contactOnB = V(normal).imul(-rB).iadd(offsetB);

  const result = createCollisionResult();
  result.contacts.push({
    worldContactA: V(contactOnA).isub(bodyA.position),
    worldContactB: V(contactOnB).isub(bodyB.position),
    normal: V(normal),
    depth: radiusSum - centerDiff.magnitude,
  });

  return result;
}

/** Circle/Particle collision */
export function circleParticle(
  bodyA: Body,
  shapeA: Circle,
  offsetA: V2d,
  _angleA: number,
  bodyB: Body,
  _shapeB: Particle,
  offsetB: V2d,
  _angleB: number,
  justTest: boolean
): CollisionResult | null {
  const circleShape = shapeA as Circle;
  const circleRadius = circleShape.radius;

  const particleToCircle = V(offsetB).isub(offsetA);
  if (particleToCircle.squaredMagnitude > circleRadius * circleRadius) {
    return null;
  }

  if (justTest) {
    return createCollisionResult();
  }

  const normal = V(particleToCircle).inormalize();

  // Contact point on circle surface
  const contactOnCircle = V(normal).imul(circleRadius).iadd(offsetA);

  const result = createCollisionResult();
  result.contacts.push({
    worldContactA: V(contactOnCircle).isub(bodyA.position),
    worldContactB: V(offsetB).isub(bodyB.position),
    normal: V(normal),
    depth: circleRadius - particleToCircle.magnitude,
  });

  return result;
}

/** Circle/Plane collision */
export function circlePlane(
  bodyA: Body,
  shapeA: Circle,
  offsetA: V2d,
  _angleA: number,
  bodyB: Body,
  _shapeB: Plane,
  offsetB: V2d,
  angleB: number,
  justTest: boolean
): CollisionResult | null {
  // Note: bodyA is circle, bodyB is plane
  const circleShape = shapeA as Circle;
  const circleRadius = circleShape.radius;

  const circleToPlane = V(offsetA).isub(offsetB);
  const planeNormal = V(yAxis).irotate(angleB);

  const distance = circleToPlane.dot(planeNormal);

  if (distance > circleRadius) {
    return null;
  }

  if (justTest) {
    return createCollisionResult();
  }

  // Contact point on circle surface (towards plane)
  const contactOnCircle = V(planeNormal).imul(-circleRadius).iadd(offsetA);
  // Contact point on plane
  const projectionOffset = V(planeNormal).imul(distance);
  const contactOnPlane = V(circleToPlane).isub(projectionOffset).iadd(offsetB);

  const result = createCollisionResult();
  result.contacts.push({
    worldContactA: V(contactOnCircle).isub(bodyA.position),
    worldContactB: V(contactOnPlane).isub(bodyB.position),
    normal: V(planeNormal).imul(-1), // Normal from circle towards plane
    depth: circleRadius - distance,
  });

  return result;
}

/** Circle/Line collision (also used for capsules via lineRadius parameter) */
export function circleLineOrCapsule(
  bodyA: Body,
  shapeA: Circle,
  offsetA: V2d,
  _angleA: number,
  bodyB: Body,
  shapeB: Line | Capsule,
  offsetB: V2d,
  angleB: number,
  justTest: boolean,
  lineRadius?: number,
  circleRadius?: number
): CollisionResult | null {
  const circleShape = shapeA as Circle;
  const lineShape = shapeB as Line | Capsule;
  const lr = lineRadius ?? 0;
  const cr = circleRadius ?? circleShape.radius;

  const halfLineLength = lineShape.length / 2;

  // Get line endpoints in world space
  const lineStart = V(-halfLineLength, 0).itoGlobalFrame(offsetB, angleB);
  const lineEnd = V(halfLineLength, 0).itoGlobalFrame(offsetB, angleB);

  // Get vector along the line
  const lineEdge = V(lineEnd).isub(lineStart);
  const lineEdgeUnit = V(lineEdge).inormalize();

  // Get tangent to the edge (perpendicular, pointing away from line)
  const lineTangent = V(lineEdgeUnit).irotate90cw();

  // Check distance from the plane spanned by the edge vs the circle
  const circleToLineStart = V(offsetA).isub(lineStart);
  const perpDistance = circleToLineStart.dot(lineTangent);
  const radiusSum = cr + lr;

  if (Math.abs(perpDistance) < radiusSum) {
    // Project circle center onto the line
    const orthoDist = V(lineTangent).imul(perpDistance);
    const projectedPoint = V(offsetA).isub(orthoDist);

    // Add the line radius offset
    const lineToCircle = V(offsetA).isub(offsetB);
    const lineToCircleOrtho = V(lineTangent).imul(
      lineTangent.dot(lineToCircle)
    );
    lineToCircleOrtho.inormalize().imul(lr);
    projectedPoint.iadd(lineToCircleOrtho);

    // Check if the point is within the edge span
    const pos = lineEdgeUnit.dot(projectedPoint);
    const pos0 = lineEdgeUnit.dot(lineStart);
    const pos1 = lineEdgeUnit.dot(lineEnd);

    if (pos > pos0 && pos < pos1) {
      if (justTest) {
        return createCollisionResult();
      }

      const normal = V(orthoDist).imul(-1).inormalize();

      // Contact point on circle
      const contactOnCircle = V(normal).imul(cr).iadd(offsetA);
      // Contact point on line
      const contactOnLine = V(projectedPoint);

      const result = createCollisionResult();
      result.contacts.push({
        worldContactA: V(contactOnCircle).isub(bodyA.position),
        worldContactB: V(contactOnLine).isub(bodyB.position),
        normal: V(normal),
        depth: radiusSum - Math.abs(perpDistance),
      });

      return result;
    }
  }

  // Check corners (line endpoints)
  const endpoints = [lineStart, lineEnd];

  for (const endpoint of endpoints) {
    const dist = V(endpoint).isub(offsetA);

    if (dist.squaredMagnitude < radiusSum * radiusSum) {
      if (justTest) {
        return createCollisionResult();
      }

      const normal = V(dist).inormalize();

      // Contact point on circle
      const contactOnCircle = V(normal).imul(cr).iadd(offsetA);
      // Contact point on line endpoint (with line radius offset)
      const contactOnLine = V(endpoint).iadd(V(normal).imul(-lr));

      const result = createCollisionResult();
      result.contacts.push({
        worldContactA: V(contactOnCircle).isub(bodyA.position),
        worldContactB: V(contactOnLine).isub(bodyB.position),
        normal: V(normal),
        depth: radiusSum - dist.magnitude,
      });

      return result;
    }
  }

  return null;
}

/** Circle/Convex collision */
export function circleConvex(
  bodyA: Body,
  shapeA: Shape,
  offsetA: V2d,
  _angleA: number,
  bodyB: Body,
  shapeB: Shape,
  offsetB: V2d,
  angleB: number,
  justTest: boolean,
  circleRadius?: number
): CollisionResult | null {
  const circleShape = shapeA as Circle;
  const convexShape = shapeB as Convex;
  const cr = circleRadius ?? circleShape.radius;

  const localCirclePos = V(offsetA).itoLocalFrame(offsetB, angleB);

  const vertices = convexShape.vertices;
  const normals = convexShape.axes;
  const numVertices = vertices.length;
  let normalIndex = -1;

  // Find the min separating edge
  let separation = -Number.MAX_VALUE;
  const radius = convexShape.boundingRadius + cr;

  for (let i = 0; i < numVertices; i++) {
    const r = V(localCirclePos).isub(vertices[i]);
    const s = normals[i].dot(r);

    if (s > radius) {
      return null; // Early out
    }

    if (s > separation) {
      separation = s;
      normalIndex = i;
    }
  }

  // Check edges first
  let found = -1;
  let minCandidateDistance = Number.MAX_VALUE;

  for (
    let i = normalIndex + numVertices - 1;
    i < normalIndex + numVertices + 2;
    i++
  ) {
    const v0 = vertices[i % numVertices];
    const n = normals[i % numVertices];

    // Get point on circle closest to the convex
    const candidate = V(n).imul(-cr).iadd(localCirclePos);

    if (pointInConvexLocal(candidate, convexShape)) {
      const candidateDist = V(v0).isub(candidate);
      const candidateDistance = Math.abs(candidateDist.dot(n));

      if (candidateDistance < minCandidateDistance) {
        minCandidateDistance = candidateDistance;
        found = i;
      }
    }
  }

  if (found !== -1) {
    if (justTest) {
      return createCollisionResult();
    }

    const v0 = vertices[found % numVertices];
    const v1 = vertices[(found + 1) % numVertices];

    const worldV0 = V(v0).itoGlobalFrame(offsetB, angleB);
    const worldV1 = V(v1).itoGlobalFrame(offsetB, angleB);

    const edge = V(worldV1).isub(worldV0);
    const edgeUnit = V(edge).inormalize();

    // Get tangent (points out of the convex)
    const normal = V(edgeUnit).irotate90cw();

    // Get point on circle closest to convex
    const candidate = V(normal).imul(-cr).iadd(offsetA);
    const closestEdgePoint = V(normal)
      .imul(minCandidateDistance)
      .iadd(candidate);

    const result = createCollisionResult();
    result.contacts.push({
      worldContactA: V(candidate).isub(bodyA.position),
      worldContactB: V(closestEdgePoint).isub(bodyB.position),
      normal: V(candidate).isub(offsetA).inormalize(),
      depth: minCandidateDistance,
    });

    return result;
  }

  // Check closest vertices
  if (cr > 0 && normalIndex !== -1) {
    for (
      let i = normalIndex + numVertices;
      i < normalIndex + numVertices + 2;
      i++
    ) {
      const localVertex = vertices[i % numVertices];
      const dist = V(localVertex).isub(localCirclePos);

      if (dist.squaredMagnitude < cr * cr) {
        if (justTest) {
          return createCollisionResult();
        }

        const worldVertex = V(localVertex).itoGlobalFrame(offsetB, angleB);
        const worldDist = V(worldVertex).isub(offsetA);

        const normal = V(worldDist).inormalize();

        const result = createCollisionResult();
        result.contacts.push({
          worldContactA: V(normal).imul(cr).isub(bodyA.position).iadd(offsetA),
          worldContactB: V(worldVertex).isub(bodyB.position),
          normal: V(normal),
          depth: cr - worldDist.magnitude,
        });

        return result;
      }
    }
  }

  return null;
}

/** Circle/Heightfield collision */
export function circleHeightfield(
  bodyA: Body,
  shapeA: Shape,
  offsetA: V2d,
  _angleA: number,
  bodyB: Body,
  shapeB: Shape,
  offsetB: V2d,
  _angleB: number,
  justTest: boolean,
  radius?: number
): CollisionResult | null {
  const circleShape = shapeA as Circle;
  const hfShape = shapeB as Heightfield;

  const data = hfShape.heights;
  const r = radius ?? circleShape.radius;
  const w = hfShape.elementWidth;

  // Get the index of the points to test against
  let idxA = Math.floor((offsetA[0] - r - offsetB[0]) / w);
  let idxB = Math.ceil((offsetA[0] + r - offsetB[0]) / w);

  if (idxA < 0) idxA = 0;
  if (idxB >= data.length) idxB = data.length - 1;

  // Get max height in range
  let max = data[idxA];
  for (let i = idxA; i < idxB; i++) {
    if (data[i] > max) max = data[i];
  }

  if (offsetA[1] - r > max + offsetB[1]) {
    return null;
  }

  const result = createCollisionResult();

  // Check all edges
  for (let i = idxA; i < idxB; i++) {
    const v0 = V(i * w + offsetB[0], data[i] + offsetB[1]);
    const v1 = V((i + 1) * w + offsetB[0], data[i + 1] + offsetB[1]);

    // Get normal (perpendicular to edge, pointing up/out)
    const edgeNormal = V(v1)
      .isub(v0)
      .irotate(Math.PI / 2)
      .inormalize();

    // Get point on circle closest to the edge
    const candidate = V(edgeNormal).imul(-r).iadd(offsetA);

    // Distance from v0 to candidate point
    const dist = V(candidate).isub(v0);

    // Check if it is in the element "stick"
    const d = dist.dot(edgeNormal);
    if (candidate[0] >= v0[0] && candidate[0] < v1[0] && d <= 0) {
      if (justTest) {
        return createCollisionResult();
      }

      // Project candidate to edge
      const projectedPoint = V(edgeNormal).imul(-d).iadd(candidate);

      result.contacts.push({
        worldContactA: V(edgeNormal)
          .imul(-r)
          .isub(bodyA.position)
          .iadd(offsetA),
        worldContactB: V(projectedPoint).isub(bodyB.position),
        normal: V(edgeNormal),
        depth: -d,
      });
    }
  }

  // Check all vertices
  if (r > 0) {
    for (let i = idxA; i <= idxB; i++) {
      const v0 = V(i * w + offsetB[0], data[i] + offsetB[1]);
      const dist = V(offsetA).isub(v0);

      if (dist.squaredMagnitude < r * r) {
        if (justTest) {
          return createCollisionResult();
        }

        const normal = V(dist).inormalize();

        result.contacts.push({
          worldContactA: V(normal).imul(-r).isub(bodyA.position).iadd(offsetA),
          worldContactB: V(v0).isub(bodyB.position),
          normal: V(normal),
          depth: r - dist.magnitude,
        });
      }
    }
  }

  if (result.contacts.length === 0) {
    return null;
  }

  return result;
}

/** Circle/Capsule collision */
export function circleCapsule(
  bodyA: Body,
  shapeA: Circle,
  offsetA: V2d,
  angleA: number,
  bodyB: Body,
  shapeB: Capsule,
  offsetB: V2d,
  angleB: number,
  justTest: boolean
): CollisionResult | null {
  const capsuleShape = shapeB;
  return circleLineOrCapsule(
    bodyA,
    shapeA,
    offsetA,
    angleA,
    bodyB,
    shapeB,
    offsetB,
    angleB,
    justTest,
    capsuleShape.radius
  );
}

/** Circle/Capsule collision */
export function circleLine(
  bodyA: Body,
  shapeA: Circle,
  offsetA: V2d,
  angleA: number,
  bodyB: Body,
  shapeB: Line,
  offsetB: V2d,
  angleB: number,
  justTest: boolean
): CollisionResult | null {
  const capsuleShape = shapeB;
  return circleLineOrCapsule(
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
