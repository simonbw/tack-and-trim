import { V, V2d } from "../../Vector";
import Body from "../body/Body";
import Box from "../shapes/Box";
import Capsule from "../shapes/Capsule";
import Circle from "../shapes/Circle";
import Convex from "../shapes/Convex";
import Heightfield from "../shapes/Heightfield";
import Line from "../shapes/Line";
import Particle from "../shapes/Particle";
import Plane from "../shapes/Plane";
import Shape from "../shapes/Shape";
import { CollisionResult, createCollisionResult } from "./CollisionResult";

// Reusable shapes for capsule collision
const capsuleMiddleRect = new Box({ width: 1, height: 1 });
const capsuleMiddleRect2 = new Box({ width: 1, height: 1 });
const tempCircle = new Circle({ radius: 1 });

// Reusable convex for heightfield collision
const heightfieldTileConvex = new Convex({
  vertices: [V(), V(), V(), V()],
});

// Clip points for convex-convex (Box2D style)
const clipPoints1 = [V(), V()];
const clipPoints2 = [V(), V()];
const incidentEdgePoints = [V(), V()];

const maxManifoldPoints = 2;
const yAxis = V(0, 1);

/**
 * Helper: Check if a point is inside a convex polygon (world space)
 */
function pointInConvex(
  worldPoint: V2d,
  convexShape: Convex,
  convexOffset: V2d,
  convexAngle: number
): boolean {
  const localPoint = V(worldPoint).itoLocalFrame(convexOffset, convexAngle);
  return pointInConvexLocal(localPoint, convexShape);
}

/**
 * Helper: Check if a point is inside a convex polygon (local space)
 */
function pointInConvexLocal(localPoint: V2d, convexShape: Convex): boolean {
  const verts = convexShape.vertices;
  const numVerts = verts.length;
  let lastCross: number | null = null;

  const r0 = V();
  const r1 = V();

  for (let i = 0; i < numVerts + 1; i++) {
    const v0 = verts[i % numVerts];
    const v1 = verts[(i + 1) % numVerts];

    r0.set(v0).isub(localPoint);
    r1.set(v1).isub(localPoint);

    const cross = r0.crossLength(r1);

    if (lastCross === null) {
      lastCross = cross;
    }

    // If we got a different sign, the point is outside
    if (cross * lastCross < 0) {
      return false;
    }
    lastCross = cross;
  }
  return true;
}

/**
 * Helper: Find the max separation between two polygons using edge normals from poly1
 * Returns the best edge index and stores the max separation in separationOut[0]
 */
function findMaxSeparation(
  separationOut: V2d,
  poly1: Convex,
  position1: V2d,
  angle1: number,
  poly2: Convex,
  position2: V2d,
  angle2: number
): number {
  const count1 = poly1.vertices.length;
  const count2 = poly2.vertices.length;
  const normals1 = poly1.axes;
  const vertices1 = poly1.vertices;
  const vertices2 = poly2.vertices;

  const rotatedNormal = V();
  const transformedVertex = V();
  const vertexDiff = V();
  const tempVec = V();

  const angle = angle1 - angle2;

  let bestIndex = 0;
  let maxSeparation = -Number.MAX_VALUE;

  for (let i = 0; i < count1; i++) {
    // Get poly1 normal in frame2
    rotatedNormal.set(normals1[i]).irotate(angle);

    // Get poly1 vertex in frame2
    tempVec.set(vertices1[i]).itoGlobalFrame(position1, angle1);
    transformedVertex.set(tempVec).itoLocalFrame(position2, angle2);

    // Find deepest point for normal i
    let minSeparation = Number.MAX_VALUE;
    for (let j = 0; j < count2; j++) {
      vertexDiff.set(vertices2[j]).isub(transformedVertex);
      const separation = rotatedNormal.dot(vertexDiff);
      if (separation < minSeparation) {
        minSeparation = separation;
      }
    }

    if (minSeparation > maxSeparation) {
      maxSeparation = minSeparation;
      bestIndex = i;
    }
  }

  separationOut[0] = maxSeparation;
  return bestIndex;
}

/**
 * Helper: Find incident edge for polygon clipping
 */
function findIncidentEdge(
  clipVerticesOut: V2d[],
  poly1: Convex,
  position1: V2d,
  angle1: number,
  edge1: number,
  poly2: Convex,
  position2: V2d,
  angle2: number
): void {
  const normals1 = poly1.axes;
  const count2 = poly2.vertices.length;
  const vertices2 = poly2.vertices;
  const normals2 = poly2.axes;

  // Get the normal of the reference edge in poly2's frame
  const referenceNormal = V(normals1[edge1]).irotate(angle1 - angle2);

  // Find the incident edge on poly2
  let incidentIndex = 0;
  let minDot = Number.MAX_VALUE;
  for (let i = 0; i < count2; i++) {
    const d = referenceNormal.dot(normals2[i]);
    if (d < minDot) {
      minDot = d;
      incidentIndex = i;
    }
  }

  // Build the clip vertices for the incident edge
  const i1 = incidentIndex;
  const i2 = i1 + 1 < count2 ? i1 + 1 : 0;

  clipVerticesOut[0].set(vertices2[i1]).itoGlobalFrame(position2, angle2);
  clipVerticesOut[1].set(vertices2[i2]).itoGlobalFrame(position2, angle2);
}

/**
 * Helper: Clip segment to line (Sutherland-Hodgman)
 */
function clipSegmentToLine(
  vOut: V2d[],
  vIn: V2d[],
  normal: V2d,
  offset: number
): number {
  let numOut = 0;

  // Calculate distance of end points to the line
  const distance0 = normal.dot(vIn[0]) - offset;
  const distance1 = normal.dot(vIn[1]) - offset;

  // If the points are behind the plane
  if (distance0 <= 0.0) {
    vOut[numOut++].set(vIn[0]);
  }
  if (distance1 <= 0.0) {
    vOut[numOut++].set(vIn[1]);
  }

  // If the points are on different sides of the plane
  if (distance0 * distance1 < 0.0) {
    // Find intersection point
    const interp = distance0 / (distance0 - distance1);
    const v = vOut[numOut];
    v.set(vIn[1]).isub(vIn[0]).imul(interp).iadd(vIn[0]);
    numOut++;
  }

  return numOut;
}

/**
 * Helper: Set convex to capsule middle rectangle
 */
function setCapsuleMiddleRect(convexShape: Box, capsuleShape: Capsule): void {
  const capsuleRadius = capsuleShape.radius;
  const halfCapsuleLength = capsuleShape.length * 0.5;
  const verts = convexShape.vertices;
  verts[0].set(-halfCapsuleLength, -capsuleRadius);
  verts[1].set(halfCapsuleLength, -capsuleRadius);
  verts[2].set(halfCapsuleLength, capsuleRadius);
  verts[3].set(-halfCapsuleLength, capsuleRadius);
}

/**
 * Collision handler function type for dispatch
 */
type CollisionHandler = (
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
      return { handler: this.circleCircle.bind(this), swap: false };
    }
    if (shapeA instanceof Circle && shapeB instanceof Particle) {
      return { handler: this.circleParticle.bind(this), swap: false };
    }
    if (shapeA instanceof Particle && shapeB instanceof Circle) {
      return { handler: this.circleParticle.bind(this), swap: true };
    }
    if (shapeA instanceof Circle && shapeB instanceof Plane) {
      return { handler: this.circlePlane.bind(this), swap: false };
    }
    if (shapeA instanceof Plane && shapeB instanceof Circle) {
      return { handler: this.circlePlane.bind(this), swap: true };
    }
    if (shapeA instanceof Circle && shapeB instanceof Convex) {
      return { handler: this.circleConvex.bind(this), swap: false };
    }
    if (shapeA instanceof Convex && shapeB instanceof Circle) {
      return { handler: this.circleConvex.bind(this), swap: true };
    }
    if (shapeA instanceof Circle && shapeB instanceof Line) {
      return { handler: this.circleLine.bind(this), swap: false };
    }
    if (shapeA instanceof Line && shapeB instanceof Circle) {
      return { handler: this.circleLine.bind(this), swap: true };
    }
    if (shapeA instanceof Circle && shapeB instanceof Capsule) {
      return { handler: this.circleCapsule.bind(this), swap: false };
    }
    if (shapeA instanceof Capsule && shapeB instanceof Circle) {
      return { handler: this.circleCapsule.bind(this), swap: true };
    }
    if (shapeA instanceof Circle && shapeB instanceof Heightfield) {
      return { handler: this.circleHeightfield.bind(this), swap: false };
    }
    if (shapeA instanceof Heightfield && shapeB instanceof Circle) {
      return { handler: this.circleHeightfield.bind(this), swap: true };
    }

    // Particle collisions
    if (shapeA instanceof Particle && shapeB instanceof Plane) {
      return { handler: this.particlePlane.bind(this), swap: false };
    }
    if (shapeA instanceof Plane && shapeB instanceof Particle) {
      return { handler: this.particlePlane.bind(this), swap: true };
    }
    if (shapeA instanceof Particle && shapeB instanceof Convex) {
      return { handler: this.particleConvex.bind(this), swap: false };
    }
    if (shapeA instanceof Convex && shapeB instanceof Particle) {
      return { handler: this.particleConvex.bind(this), swap: true };
    }
    if (shapeA instanceof Particle && shapeB instanceof Capsule) {
      return { handler: this.particleCapsule.bind(this), swap: false };
    }
    if (shapeA instanceof Capsule && shapeB instanceof Particle) {
      return { handler: this.particleCapsule.bind(this), swap: true };
    }

    // Plane collisions
    if (shapeA instanceof Plane && shapeB instanceof Convex) {
      return { handler: this.planeConvex.bind(this), swap: false };
    }
    if (shapeA instanceof Convex && shapeB instanceof Plane) {
      return { handler: this.planeConvex.bind(this), swap: true };
    }
    if (shapeA instanceof Plane && shapeB instanceof Line) {
      return { handler: this.planeLine.bind(this), swap: false };
    }
    if (shapeA instanceof Line && shapeB instanceof Plane) {
      return { handler: this.planeLine.bind(this), swap: true };
    }
    if (shapeA instanceof Plane && shapeB instanceof Capsule) {
      return { handler: this.planeCapsule.bind(this), swap: false };
    }
    if (shapeA instanceof Capsule && shapeB instanceof Plane) {
      return { handler: this.planeCapsule.bind(this), swap: true };
    }

    // Convex collisions
    if (shapeA instanceof Convex && shapeB instanceof Convex) {
      return { handler: this.convexConvex.bind(this), swap: false };
    }
    if (shapeA instanceof Convex && shapeB instanceof Capsule) {
      return { handler: this.convexCapsule.bind(this), swap: false };
    }
    if (shapeA instanceof Capsule && shapeB instanceof Convex) {
      return { handler: this.convexCapsule.bind(this), swap: true };
    }
    if (shapeA instanceof Convex && shapeB instanceof Heightfield) {
      return { handler: this.convexHeightfield.bind(this), swap: false };
    }
    if (shapeA instanceof Heightfield && shapeB instanceof Convex) {
      return { handler: this.convexHeightfield.bind(this), swap: true };
    }

    // Capsule collisions
    if (shapeA instanceof Capsule && shapeB instanceof Capsule) {
      return { handler: this.capsuleCapsule.bind(this), swap: false };
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

  // ========== COLLISION METHODS ==========

  /**
   * Circle/Circle collision
   */
  circleCircle(
    bodyA: Body,
    shapeA: Shape,
    offsetA: V2d,
    _angleA: number,
    bodyB: Body,
    shapeB: Shape,
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

  /**
   * Circle/Particle collision
   */
  circleParticle(
    bodyA: Body,
    shapeA: Shape,
    offsetA: V2d,
    _angleA: number,
    bodyB: Body,
    shapeB: Shape,
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

  /**
   * Particle/Plane collision
   */
  particlePlane(
    bodyA: Body,
    shapeA: Shape,
    offsetA: V2d,
    _angleA: number,
    bodyB: Body,
    shapeB: Shape,
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

  /**
   * Circle/Plane collision
   */
  circlePlane(
    bodyA: Body,
    shapeA: Shape,
    offsetA: V2d,
    _angleA: number,
    bodyB: Body,
    shapeB: Shape,
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
    const contactOnPlane = V(circleToPlane)
      .isub(projectionOffset)
      .iadd(offsetB);

    const result = createCollisionResult();
    result.contacts.push({
      worldContactA: V(contactOnCircle).isub(bodyA.position),
      worldContactB: V(contactOnPlane).isub(bodyB.position),
      normal: V(planeNormal).imul(-1), // Normal from circle towards plane
      depth: circleRadius - distance,
    });

    return result;
  }

  /**
   * Circle/Line collision (also used for capsules via lineRadius parameter)
   */
  circleLine(
    bodyA: Body,
    shapeA: Shape,
    offsetA: V2d,
    _angleA: number,
    bodyB: Body,
    shapeB: Shape,
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

  /**
   * Circle/Capsule collision
   */
  circleCapsule(
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
    const capsuleShape = shapeB as Capsule;
    return this.circleLine(
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

  /**
   * Particle/Capsule collision
   */
  particleCapsule(
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
    const capsuleShape = shapeB as Capsule;
    return this.circleLine(
      bodyA,
      shapeA,
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

  /**
   * Plane/Line collision
   */
  planeLine(
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

  /**
   * Plane/Capsule collision
   */
  planeCapsule(
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
    const result1 = this.circlePlane(
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

    const result2 = this.circlePlane(
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

  /**
   * Particle/Convex collision
   */
  particleConvex(
    bodyA: Body,
    shapeA: Shape,
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

  /**
   * Circle/Convex collision
   */
  circleConvex(
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
            worldContactA: V(normal)
              .imul(cr)
              .isub(bodyA.position)
              .iadd(offsetA),
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

  /**
   * Plane/Convex collision
   */
  planeConvex(
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

  /**
   * Convex/Convex collision (SAT with edge clipping)
   */
  convexConvex(
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
  convexCapsule(
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
    const result1 = this.circleConvex(
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
    const result2 = this.circleConvex(
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
    const result3 = this.convexConvex(
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
   * Capsule/Capsule collision
   */
  capsuleCapsule(
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
    const capsuleA = shapeA as Capsule;
    const capsuleB = shapeB as Capsule;

    const result = createCollisionResult();

    // Need 4 circle checks between all endpoints
    for (let i = 0; i < 2; i++) {
      const circlePosA = V(
        (i === 0 ? -1 : 1) * (capsuleA.length / 2),
        0
      ).itoGlobalFrame(offsetA, angleA);

      for (let j = 0; j < 2; j++) {
        const circlePosB = V(
          (j === 0 ? -1 : 1) * (capsuleB.length / 2),
          0
        ).itoGlobalFrame(offsetB, angleB);

        const circleResult = this.circleCircle(
          bodyA,
          capsuleA,
          circlePosA,
          angleA,
          bodyB,
          capsuleB,
          circlePosB,
          angleB,
          justTest,
          capsuleA.radius,
          capsuleB.radius
        );

        if (justTest && circleResult) {
          return createCollisionResult();
        }

        if (circleResult) {
          result.contacts.push(...circleResult.contacts);
        }
      }
    }

    // Check circles against center boxes
    setCapsuleMiddleRect(capsuleMiddleRect, capsuleA);
    const rect1Result = this.convexCapsule(
      bodyA,
      capsuleMiddleRect,
      offsetA,
      angleA,
      bodyB,
      capsuleB,
      offsetB,
      angleB,
      justTest
    );

    if (justTest && rect1Result) {
      return createCollisionResult();
    }

    if (rect1Result) {
      result.contacts.push(...rect1Result.contacts);
    }

    setCapsuleMiddleRect(capsuleMiddleRect2, capsuleB);
    const rect2Result = this.convexCapsule(
      bodyB,
      capsuleMiddleRect2,
      offsetB,
      angleB,
      bodyA,
      capsuleA,
      offsetA,
      angleA,
      justTest
    );

    if (justTest && rect2Result) {
      return createCollisionResult();
    }

    if (rect2Result) {
      // Swap contacts since we called with swapped bodies
      for (const contact of rect2Result.contacts) {
        result.contacts.push({
          worldContactA: contact.worldContactB,
          worldContactB: contact.worldContactA,
          normal: V(contact.normal).imul(-1),
          depth: contact.depth,
        });
      }
    }

    if (result.contacts.length === 0) {
      return null;
    }

    return result;
  }

  /**
   * Circle/Heightfield collision
   */
  circleHeightfield(
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
            worldContactA: V(normal)
              .imul(-r)
              .isub(bodyA.position)
              .iadd(offsetA),
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

  /**
   * Convex/Heightfield collision
   */
  convexHeightfield(
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
      const tileResult = this.convexConvex(
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
}
