import { V, V2d } from "../../Vector";
import Body from "../body/Body";
import ContactEquation from "../equations/ContactEquation";
import Equation from "../equations/Equation";
import FrictionEquation from "../equations/FrictionEquation";
import Box from "../shapes/Box";
import Capsule from "../shapes/Capsule";
import Circle from "../shapes/Circle";
import Convex from "../shapes/Convex";
import Heightfield from "../shapes/Heightfield";
import Line from "../shapes/Line";
import Shape from "../shapes/Shape";
import ContactEquationPool from "../utils/ContactEquationPool";
import FrictionEquationPool from "../utils/FrictionEquationPool";
import TupleDictionary from "../utils/TupleDictionary";
import type World from "../world/World";

// Temp vectors for collision methods - reused to avoid allocations
const yAxis = V(0, 1);
const tmp1 = V();
const tmp2 = V();
const tmp3 = V();
const tmp4 = V();
const tmp5 = V();
const tmp6 = V();
const tmp7 = V();
const tmp8 = V();
const tmp9 = V();
const tmp10 = V();
const tmp11 = V();
const tmp12 = V();
const tmp13 = V();
const tmp14 = V();
const tmp15 = V();

// Temp vectors for specific collision methods
const pic_r0 = V();
const pic_r1 = V();

// For convexConvex
const collidePolygons_tempVec = V();
const collidePolygons_tmpVec = V();
const collidePolygons_localTangent = V();
const collidePolygons_localNormal = V();
const collidePolygons_planePoint = V();
const collidePolygons_tangent = V();
const collidePolygons_normal = V();
const collidePolygons_negativeTangent = V();
const collidePolygons_v11 = V();
const collidePolygons_v12 = V();
const collidePolygons_dist = V();
const collidePolygons_clipPoints1 = [V(), V()];
const collidePolygons_clipPoints2 = [V(), V()];
const collidePolygons_incidentEdge = [V(), V()];

// For findMaxSeparation
const findMaxSeparation_n = V();
const findMaxSeparation_v1 = V();
const findMaxSeparation_tmp = V();
const findMaxSeparation_tmp2 = V();

// For findIncidentEdge
const findIncidentEdge_normal1 = V();

// For convexCapsule
const convexCapsule_tempRect = new Box({ width: 1, height: 1 });
const convexCapsule_tempVec = V();

// For capsuleCapsule
const capsuleCapsule_tempVec1 = V();
const capsuleCapsule_tempVec2 = V();
const capsuleCapsule_tempRect1 = new Box({ width: 1, height: 1 });

// For planeCapsule
const planeCapsule_tmpCircle = new Circle({ radius: 1 });
const planeCapsule_tmp1 = V();
const planeCapsule_tmp2 = V();

// For heightfield
const circleHeightfield_candidate = V();
const circleHeightfield_dist = V();
const circleHeightfield_v0 = V();
const circleHeightfield_v1 = V();
const circleHeightfield_minCandidate = V();
const circleHeightfield_worldNormal = V();
const circleHeightfield_minCandidateNormal = V();

const convexHeightfield_v0 = V();
const convexHeightfield_v1 = V();
const convexHeightfield_tilePos = V();
const convexHeightfield_tempConvexShape = new Convex({
  vertices: [V(), V(), V(), V()],
});

const maxManifoldPoints = 2;

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

  for (let i = 0; i < numVerts + 1; i++) {
    const v0 = verts[i % numVerts];
    const v1 = verts[(i + 1) % numVerts];

    pic_r0.set(v0).isub(localPoint);
    pic_r1.set(v1).isub(localPoint);

    const cross = pic_r0.crossLength(pic_r1);

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
 */
function findMaxSeparation(
  maxSeparationOut: V2d,
  poly1: Convex,
  position1: V2d,
  angle1: number,
  poly2: Convex,
  position2: V2d,
  angle2: number
): number {
  const count1 = poly1.vertices.length;
  const count2 = poly2.vertices.length;
  const n1s = poly1.axes; // p2 uses normals, we use axes
  const v1s = poly1.vertices;
  const v2s = poly2.vertices;

  const n = findMaxSeparation_n;
  const v1 = findMaxSeparation_v1;
  const tmp = findMaxSeparation_tmp;
  const tmp2 = findMaxSeparation_tmp2;

  const angle = angle1 - angle2;

  let bestIndex = 0;
  let maxSeparation = -Number.MAX_VALUE;

  for (let i = 0; i < count1; i++) {
    // Get poly1 normal in frame2
    n.set(n1s[i]).irotate(angle);

    // Get poly1 vertex in frame2
    tmp2.set(v1s[i]).itoGlobalFrame(position1, angle1);
    v1.set(tmp2).itoLocalFrame(position2, angle2);

    // Find deepest point for normal i
    let si = Number.MAX_VALUE;
    for (let j = 0; j < count2; j++) {
      tmp.set(v2s[j]).isub(v1);
      const sij = n.dot(tmp);
      if (sij < si) {
        si = sij;
      }
    }

    if (si > maxSeparation) {
      maxSeparation = si;
      bestIndex = i;
    }
  }

  // Use V2d for storing the float value
  maxSeparationOut[0] = maxSeparation;

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
  const normal1 = findIncidentEdge_normal1;
  normal1.set(normals1[edge1]).irotate(angle1 - angle2);

  // Find the incident edge on poly2
  let index = 0;
  let minDot = Number.MAX_VALUE;
  for (let i = 0; i < count2; i++) {
    const d = normal1.dot(normals2[i]);
    if (d < minDot) {
      minDot = d;
      index = i;
    }
  }

  // Build the clip vertices for the incident edge
  const i1 = index;
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
function setConvexToCapsuleShapeMiddle(
  convexShape: Box,
  capsuleShape: Capsule
): void {
  const capsuleRadius = capsuleShape.radius;
  const halfCapsuleLength = capsuleShape.length * 0.5;
  const verts = convexShape.vertices;
  verts[0].set(-halfCapsuleLength, -capsuleRadius);
  verts[1].set(halfCapsuleLength, -capsuleRadius);
  verts[2].set(halfCapsuleLength, capsuleRadius);
  verts[3].set(-halfCapsuleLength, capsuleRadius);
}

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

    // Register collision methods
    this[Shape.CIRCLE] = this.circleCircle;
    this[Shape.CIRCLE | Shape.PARTICLE] = this.circleParticle;
    this[Shape.CIRCLE | Shape.PLANE] = this.circlePlane;
    this[Shape.CIRCLE | Shape.CONVEX] = this.circleConvex;
    this[Shape.CIRCLE | Shape.BOX] = this.circleConvex;
    this[Shape.CIRCLE | Shape.LINE] = this.circleLine;
    this[Shape.CIRCLE | Shape.CAPSULE] = this.circleCapsule;
    this[Shape.CIRCLE | Shape.HEIGHTFIELD] = this.circleHeightfield;

    this[Shape.PARTICLE | Shape.PLANE] = this.particlePlane;
    this[Shape.PARTICLE | Shape.CONVEX] = this.particleConvex;
    this[Shape.PARTICLE | Shape.BOX] = this.particleConvex;
    this[Shape.PARTICLE | Shape.CAPSULE] = this.particleCapsule;

    this[Shape.PLANE | Shape.CONVEX] = this.planeConvex;
    this[Shape.PLANE | Shape.BOX] = this.planeConvex;
    this[Shape.PLANE | Shape.LINE] = this.planeLine;
    this[Shape.PLANE | Shape.CAPSULE] = this.planeCapsule;

    this[Shape.CONVEX] = this.convexConvex;
    this[Shape.CONVEX | Shape.BOX] = this.convexConvex;
    this[Shape.BOX] = this.convexConvex;
    this[Shape.CONVEX | Shape.CAPSULE] = this.convexCapsule;
    this[Shape.BOX | Shape.CAPSULE] = this.convexCapsule;
    this[Shape.CONVEX | Shape.HEIGHTFIELD] = this.convexHeightfield;
    this[Shape.BOX | Shape.HEIGHTFIELD] = this.convexHeightfield;

    this[Shape.CAPSULE] = this.capsuleCapsule;

    // Not implemented (return 0)
    this[Shape.LINE] = this.lineLine;
    this[Shape.LINE | Shape.BOX] = this.lineBox;
    this[Shape.LINE | Shape.CAPSULE] = this.lineCapsule;
    this[Shape.CONVEX | Shape.LINE] = this.convexLine;
  }

  /**
   * Check if bodies overlap.
   */
  bodiesOverlap(bodyA: Body, bodyB: Body): boolean {
    for (let k = 0, Nshapesi = bodyA.shapes.length; k !== Nshapesi; k++) {
      const shapeA = bodyA.shapes[k];
      const shapePositionA = bodyA.toWorldFrame(shapeA.position);

      for (let l = 0, Nshapesj = bodyB.shapes.length; l !== Nshapesj; l++) {
        const shapeB = bodyB.shapes[l];
        const shapePositionB = bodyB.toWorldFrame(shapeB.position);

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
            true
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
   * Check if bodies were colliding last step
   */
  collidedLastStep(bodyA: Body, bodyB: Body): boolean {
    return !!this.collidingBodiesLastStep.get(bodyA.id, bodyB.id);
  }

  /**
   * Reset the narrowphase.
   */
  reset(): void {
    // Track which bodies were colliding
    this.collidingBodiesLastStep.reset();
    const eqs = this.contactEquations;
    for (let i = 0; i < eqs.length; i++) {
      const eq = eqs[i];
      this.collidingBodiesLastStep.set(eq.bodyA.id, eq.bodyB.id, true);
    }

    // Release contact equations back to pool
    while (this.contactEquations.length > 0) {
      const eq = this.contactEquations.pop()!;
      this.contactEquationPool.release(eq);
    }

    // Release friction equations back to pool
    while (this.frictionEquations.length > 0) {
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

  /**
   * Creates a FrictionEquation from a ContactEquation
   */
  createFrictionFromContact(c: ContactEquation): FrictionEquation {
    const eq = this.createFrictionEquation(
      c.bodyA,
      c.bodyB,
      c.shapeA!,
      c.shapeB!
    );
    eq.contactPointA.set(c.contactPointA);
    eq.contactPointB.set(c.contactPointB);
    eq.t.set(c.normalA).irotate90cw();
    eq.contactEquations.push(c);
    return eq;
  }

  /**
   * Creates averaged friction from multiple contacts
   */
  createFrictionFromAverage(numContacts: number): FrictionEquation {
    const c = this.contactEquations[this.contactEquations.length - 1];
    const eq = this.createFrictionEquation(
      c.bodyA,
      c.bodyB,
      c.shapeA!,
      c.shapeB!
    );
    const bodyA = c.bodyA;

    eq.contactPointA.set(0, 0);
    eq.contactPointB.set(0, 0);
    eq.t.set(0, 0);

    for (let i = 0; i < numContacts; i++) {
      const contact =
        this.contactEquations[this.contactEquations.length - 1 - i];
      if (contact.bodyA === bodyA) {
        eq.t.iadd(contact.normalA);
        eq.contactPointA.iadd(contact.contactPointA);
        eq.contactPointB.iadd(contact.contactPointB);
      } else {
        eq.t.isub(contact.normalA);
        eq.contactPointA.iadd(contact.contactPointB);
        eq.contactPointB.iadd(contact.contactPointA);
      }
      eq.contactEquations.push(contact);
    }

    const invNumContacts = 1 / numContacts;
    eq.contactPointA.imul(invNumContacts);
    eq.contactPointB.imul(invNumContacts);
    eq.t.inormalize();
    eq.t.irotate90cw();
    return eq;
  }

  // ========== COLLISION METHODS ==========

  /**
   * Circle/Circle collision
   */
  circleCircle(
    bodyA: Body,
    shapeA: Circle,
    offsetA: V2d,
    _angleA: number,
    bodyB: Body,
    shapeB: Circle,
    offsetB: V2d,
    _angleB: number,
    justTest?: boolean,
    radiusA?: number,
    radiusB?: number
  ): number {
    const dist = tmp1;
    const rA = radiusA ?? shapeA.radius;
    const rB = radiusB ?? shapeB.radius;

    dist.set(offsetA).isub(offsetB);
    const r = rA + rB;
    if (dist.squaredMagnitude > r * r) {
      return 0;
    }

    if (justTest) {
      return 1;
    }

    const c = this.createContactEquation(bodyA, bodyB, shapeA, shapeB);
    const normalA = c.normalA;

    normalA.set(offsetB).isub(offsetA);
    normalA.inormalize();

    c.contactPointA.set(normalA).imul(rA);
    c.contactPointB.set(normalA).imul(-rB);

    c.contactPointA.iadd(offsetA).isub(bodyA.position);
    c.contactPointB.iadd(offsetB).isub(bodyB.position);

    this.contactEquations.push(c);

    if (this.enableFriction) {
      this.frictionEquations.push(this.createFrictionFromContact(c));
    }
    return 1;
  }

  /**
   * Circle/Particle collision
   */
  circleParticle(
    circleBody: Body,
    circleShape: Circle,
    circleOffset: V2d,
    _circleAngle: number,
    particleBody: Body,
    particleShape: Shape,
    particleOffset: V2d,
    _particleAngle: number,
    justTest?: boolean
  ): number {
    const dist = tmp1;
    const circleRadius = circleShape.radius;

    dist.set(particleOffset).isub(circleOffset);
    if (dist.squaredMagnitude > circleRadius * circleRadius) {
      return 0;
    }
    if (justTest) {
      return 1;
    }

    const c = this.createContactEquation(
      circleBody,
      particleBody,
      circleShape,
      particleShape
    );
    const normalA = c.normalA;

    normalA.set(dist);
    normalA.inormalize();

    c.contactPointA.set(normalA).imul(circleRadius);
    c.contactPointA.iadd(circleOffset).isub(circleBody.position);

    c.contactPointB.set(particleOffset).isub(particleBody.position);

    this.contactEquations.push(c);

    if (this.enableFriction) {
      this.frictionEquations.push(this.createFrictionFromContact(c));
    }

    return 1;
  }

  /**
   * Particle/Plane collision
   */
  particlePlane(
    particleBody: Body,
    particleShape: Shape,
    particleOffset: V2d,
    _particleAngle: number,
    planeBody: Body,
    planeShape: Shape,
    planeOffset: V2d,
    planeAngle: number,
    justTest?: boolean
  ): number {
    const dist = tmp1;
    const worldNormal = tmp2;

    dist.set(particleOffset).isub(planeOffset);
    worldNormal.set(yAxis).irotate(planeAngle);

    const d = dist.dot(worldNormal);

    if (d > 0) {
      return 0;
    }
    if (justTest) {
      return 1;
    }

    const c = this.createContactEquation(
      planeBody,
      particleBody,
      planeShape,
      particleShape
    );

    c.normalA.set(worldNormal);

    // ri is the particle position projected down onto the plane
    tmp3.set(c.normalA).imul(d);
    c.contactPointA.set(particleOffset).isub(tmp3);
    c.contactPointA.isub(planeBody.position);

    // rj is from body center to particle center
    c.contactPointB.set(particleOffset).isub(particleBody.position);

    this.contactEquations.push(c);

    if (this.enableFriction) {
      this.frictionEquations.push(this.createFrictionFromContact(c));
    }
    return 1;
  }

  /**
   * Circle/Plane collision
   */
  circlePlane(
    circleBody: Body,
    circleShape: Circle,
    circleOffset: V2d,
    _circleAngle: number,
    planeBody: Body,
    planeShape: Shape,
    planeOffset: V2d,
    planeAngle: number,
    justTest?: boolean
  ): number {
    const circleRadius = circleShape.radius;
    const planeToCircle = tmp1;
    const worldNormal = tmp2;
    const temp = tmp3;

    planeToCircle.set(circleOffset).isub(planeOffset);
    worldNormal.set(yAxis).irotate(planeAngle);

    const d = worldNormal.dot(planeToCircle);

    if (d > circleRadius) {
      return 0;
    }

    if (justTest) {
      return 1;
    }

    const contact = this.createContactEquation(
      planeBody,
      circleBody,
      planeShape,
      circleShape
    );

    contact.normalA.set(worldNormal);

    // rj is vector from circle center to contact point
    contact.contactPointB.set(contact.normalA).imul(-circleRadius);
    contact.contactPointB.iadd(circleOffset).isub(circleBody.position);

    // ri is distance from plane center to contact
    temp.set(contact.normalA).imul(d);
    contact.contactPointA.set(planeToCircle).isub(temp);
    contact.contactPointA.iadd(planeOffset).isub(planeBody.position);

    this.contactEquations.push(contact);

    if (this.enableFriction) {
      this.frictionEquations.push(this.createFrictionFromContact(contact));
    }

    return 1;
  }

  /**
   * Circle/Line collision (also used for capsules)
   */
  circleLine(
    circleBody: Body,
    circleShape: Circle,
    circleOffset: V2d,
    _circleAngle: number,
    lineBody: Body,
    lineShape: Line | Capsule,
    lineOffset: V2d,
    lineAngle: number,
    justTest?: boolean,
    lineRadius?: number,
    circleRadius?: number
  ): number {
    const lr = lineRadius ?? 0;
    const cr = circleRadius ?? circleShape.radius;

    const orthoDist = tmp1;
    const lineToCircleOrthoUnit = tmp2;
    const projectedPoint = tmp3;
    const centerDist = tmp4;
    const worldTangent = tmp5;
    const worldEdge = tmp6;
    const worldEdgeUnit = tmp7;
    const worldVertex0 = tmp8;
    const worldVertex1 = tmp9;
    const dist = tmp12;
    const lineToCircle = tmp13;
    const lineEndToLineRadius = tmp14;

    const halfLineLength = lineShape.length / 2;

    // Get line endpoints in world space
    worldVertex0.set(-halfLineLength, 0).itoGlobalFrame(lineOffset, lineAngle);
    worldVertex1.set(halfLineLength, 0).itoGlobalFrame(lineOffset, lineAngle);

    // Get vector along the line
    worldEdge.set(worldVertex1).isub(worldVertex0);
    worldEdgeUnit.set(worldEdge).inormalize();

    // Get tangent to the edge
    worldTangent.set(worldEdgeUnit).irotate90cw();

    // Check distance from the plane spanned by the edge vs the circle
    dist.set(circleOffset).isub(worldVertex0);
    const d = dist.dot(worldTangent);
    centerDist.set(worldVertex0).isub(lineOffset);

    lineToCircle.set(circleOffset).isub(lineOffset);

    const radiusSum = cr + lr;

    if (Math.abs(d) < radiusSum) {
      // Project circle onto the edge
      orthoDist.set(worldTangent).imul(d);
      projectedPoint.set(circleOffset).isub(orthoDist);

      // Add the line radius offset
      lineToCircleOrthoUnit
        .set(worldTangent)
        .imul(worldTangent.dot(lineToCircle));
      lineToCircleOrthoUnit.inormalize();
      lineToCircleOrthoUnit.imul(lr);
      projectedPoint.iadd(lineToCircleOrthoUnit);

      // Check if the point is within the edge span
      const pos = worldEdgeUnit.dot(projectedPoint);
      const pos0 = worldEdgeUnit.dot(worldVertex0);
      const pos1 = worldEdgeUnit.dot(worldVertex1);

      if (pos > pos0 && pos < pos1) {
        if (justTest) {
          return 1;
        }

        const c = this.createContactEquation(
          circleBody,
          lineBody,
          circleShape,
          lineShape
        );

        c.normalA.set(orthoDist).imul(-1);
        c.normalA.inormalize();

        c.contactPointA.set(c.normalA).imul(cr);
        c.contactPointA.iadd(circleOffset).isub(circleBody.position);

        c.contactPointB.set(projectedPoint).isub(lineOffset);
        c.contactPointB.iadd(lineOffset).isub(lineBody.position);

        this.contactEquations.push(c);

        if (this.enableFriction) {
          this.frictionEquations.push(this.createFrictionFromContact(c));
        }

        return 1;
      }
    }

    // Check corners
    const verts = [worldVertex0, worldVertex1];

    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      dist.set(v).isub(circleOffset);

      if (dist.squaredMagnitude < radiusSum * radiusSum) {
        if (justTest) {
          return 1;
        }

        const c = this.createContactEquation(
          circleBody,
          lineBody,
          circleShape,
          lineShape
        );

        c.normalA.set(dist);
        c.normalA.inormalize();

        c.contactPointA.set(c.normalA).imul(cr);
        c.contactPointA.iadd(circleOffset).isub(circleBody.position);

        c.contactPointB.set(v).isub(lineOffset);
        lineEndToLineRadius.set(c.normalA).imul(-lr);
        c.contactPointB.iadd(lineEndToLineRadius);
        c.contactPointB.iadd(lineOffset).isub(lineBody.position);

        this.contactEquations.push(c);

        if (this.enableFriction) {
          this.frictionEquations.push(this.createFrictionFromContact(c));
        }

        return 1;
      }
    }

    return 0;
  }

  /**
   * Circle/Capsule collision
   */
  circleCapsule(
    circleBody: Body,
    circleShape: Circle,
    circleOffset: V2d,
    circleAngle: number,
    capsuleBody: Body,
    capsuleShape: Capsule,
    capsuleOffset: V2d,
    capsuleAngle: number,
    justTest?: boolean
  ): number {
    return this.circleLine(
      circleBody,
      circleShape,
      circleOffset,
      circleAngle,
      capsuleBody,
      capsuleShape,
      capsuleOffset,
      capsuleAngle,
      justTest,
      capsuleShape.radius
    );
  }

  /**
   * Particle/Capsule collision
   */
  particleCapsule(
    particleBody: Body,
    particleShape: Shape,
    particleOffset: V2d,
    particleAngle: number,
    capsuleBody: Body,
    capsuleShape: Capsule,
    capsuleOffset: V2d,
    capsuleAngle: number,
    justTest?: boolean
  ): number {
    return this.circleLine(
      particleBody,
      particleShape as any,
      particleOffset,
      particleAngle,
      capsuleBody,
      capsuleShape,
      capsuleOffset,
      capsuleAngle,
      justTest,
      capsuleShape.radius,
      0
    );
  }

  /**
   * Plane/Line collision
   */
  planeLine(
    planeBody: Body,
    planeShape: Shape,
    planeOffset: V2d,
    planeAngle: number,
    lineBody: Body,
    lineShape: Line,
    lineOffset: V2d,
    lineAngle: number,
    justTest?: boolean
  ): number {
    const worldVertex0 = tmp1;
    const worldVertex1 = tmp2;
    const worldNormal = tmp8;
    const dist = tmp7;
    let numContacts = 0;

    // Get line endpoints
    const halfLength = lineShape.length / 2;
    worldVertex0.set(-halfLength, 0).itoGlobalFrame(lineOffset, lineAngle);
    worldVertex1.set(halfLength, 0).itoGlobalFrame(lineOffset, lineAngle);

    worldNormal.set(yAxis).irotate(planeAngle);

    // Check line ends
    const verts = [worldVertex0, worldVertex1];
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      dist.set(v).isub(planeOffset);
      const d = dist.dot(worldNormal);

      if (d < 0) {
        if (justTest) {
          return 1;
        }

        const c = this.createContactEquation(
          planeBody,
          lineBody,
          planeShape,
          lineShape
        );
        numContacts++;

        c.normalA.set(worldNormal);
        c.normalA.inormalize();

        // Distance vector along plane normal
        dist.set(worldNormal).imul(d);

        // Vector from plane center to contact
        c.contactPointA.set(v).isub(dist);
        c.contactPointA.isub(planeBody.position);

        // From line center to contact
        c.contactPointB.set(v).isub(lineOffset);
        c.contactPointB.iadd(lineOffset).isub(lineBody.position);

        this.contactEquations.push(c);

        if (!this.enableFrictionReduction) {
          if (this.enableFriction) {
            this.frictionEquations.push(this.createFrictionFromContact(c));
          }
        }
      }
    }

    if (justTest) {
      return 0;
    }

    if (this.enableFrictionReduction) {
      if (numContacts && this.enableFriction) {
        this.frictionEquations.push(
          this.createFrictionFromAverage(numContacts)
        );
      }
    }

    return numContacts;
  }

  /**
   * Plane/Capsule collision
   */
  planeCapsule(
    planeBody: Body,
    planeShape: Shape,
    planeOffset: V2d,
    planeAngle: number,
    capsuleBody: Body,
    capsuleShape: Capsule,
    capsuleOffset: V2d,
    capsuleAngle: number,
    justTest?: boolean
  ): number {
    const end1 = planeCapsule_tmp1;
    const end2 = planeCapsule_tmp2;
    const circle = planeCapsule_tmpCircle;
    const halfLength = capsuleShape.length / 2;

    // Compute world end positions
    end1.set(-halfLength, 0).itoGlobalFrame(capsuleOffset, capsuleAngle);
    end2.set(halfLength, 0).itoGlobalFrame(capsuleOffset, capsuleAngle);

    circle.radius = capsuleShape.radius;

    let enableFrictionBefore: boolean | undefined;

    if (this.enableFrictionReduction) {
      enableFrictionBefore = this.enableFriction;
      this.enableFriction = false;
    }

    const numContacts1 = this.circlePlane(
      capsuleBody,
      circle,
      end1,
      0,
      planeBody,
      planeShape,
      planeOffset,
      planeAngle,
      justTest
    );
    const numContacts2 = this.circlePlane(
      capsuleBody,
      circle,
      end2,
      0,
      planeBody,
      planeShape,
      planeOffset,
      planeAngle,
      justTest
    );

    if (this.enableFrictionReduction) {
      this.enableFriction = enableFrictionBefore!;
    }

    if (justTest) {
      return numContacts1 + numContacts2;
    }

    const numTotal = numContacts1 + numContacts2;
    if (this.enableFrictionReduction) {
      if (numTotal && this.enableFriction) {
        this.frictionEquations.push(this.createFrictionFromAverage(numTotal));
      }
    }
    return numTotal;
  }

  /**
   * Particle/Convex collision
   */
  particleConvex(
    particleBody: Body,
    particleShape: Shape,
    particleOffset: V2d,
    _particleAngle: number,
    convexBody: Body,
    convexShape: Convex,
    convexOffset: V2d,
    convexAngle: number,
    justTest?: boolean
  ): number {
    const worldVertex0 = tmp1;
    const worldVertex1 = tmp2;
    const worldEdge = tmp3;
    const worldEdgeUnit = tmp4;
    const worldTangent = tmp5;
    const convexToParticle = tmp7;
    const closestEdgeProjectedPoint = tmp13;
    const candidateDist = tmp14;
    const minEdgeNormal = tmp15;
    let minCandidateDistance = Number.MAX_VALUE;
    let found = false;
    const verts = convexShape.vertices;

    // Check if particle is inside polygon
    if (
      !pointInConvex(particleOffset, convexShape, convexOffset, convexAngle)
    ) {
      return 0;
    }

    if (justTest) {
      return 1;
    }

    // Find closest edge
    for (let i = 0, numVerts = verts.length; i !== numVerts + 1; i++) {
      const v0 = verts[i % numVerts];
      const v1 = verts[(i + 1) % numVerts];

      // Transform vertices to world
      worldVertex0.set(v0).irotate(convexAngle).iadd(convexOffset);
      worldVertex1.set(v1).irotate(convexAngle).iadd(convexOffset);

      // Get world edge
      worldEdge.set(worldVertex1).isub(worldVertex0);
      worldEdgeUnit.set(worldEdge).inormalize();

      // Get tangent (points out of the convex)
      worldTangent.set(worldEdgeUnit).irotate90cw();

      convexToParticle.set(particleOffset).isub(convexOffset);

      candidateDist.set(worldVertex0).isub(particleOffset);
      const candidateDistance = Math.abs(candidateDist.dot(worldTangent));

      if (candidateDistance < minCandidateDistance) {
        minCandidateDistance = candidateDistance;
        closestEdgeProjectedPoint
          .set(worldTangent)
          .imul(candidateDistance)
          .iadd(particleOffset);
        minEdgeNormal.set(worldTangent);
        found = true;
      }
    }

    if (found) {
      const c = this.createContactEquation(
        particleBody,
        convexBody,
        particleShape,
        convexShape
      );

      c.normalA.set(minEdgeNormal).imul(-1);
      c.normalA.inormalize();

      // Particle has no extent to the contact point
      c.contactPointA.set(0, 0);
      c.contactPointA.iadd(particleOffset).isub(particleBody.position);

      // From convex center to point
      c.contactPointB.set(closestEdgeProjectedPoint).isub(convexOffset);
      c.contactPointB.iadd(convexOffset).isub(convexBody.position);

      this.contactEquations.push(c);

      if (this.enableFriction) {
        this.frictionEquations.push(this.createFrictionFromContact(c));
      }

      return 1;
    }

    return 0;
  }

  /**
   * Circle/Convex collision
   */
  circleConvex(
    circleBody: Body,
    circleShape: Circle,
    circleOffset: V2d,
    _circleAngle: number,
    convexBody: Body,
    convexShape: Convex,
    convexOffset: V2d,
    convexAngle: number,
    justTest?: boolean,
    circleRadius?: number
  ): number {
    const cr = circleRadius ?? circleShape.radius;

    const worldVertex0 = tmp1;
    const worldVertex1 = tmp2;
    const edge = tmp3;
    const edgeUnit = tmp4;
    const normal = tmp5;
    const localCirclePosition = tmp7;
    const r = tmp8;
    const dist = tmp10;
    const worldVertex = tmp11;
    const closestEdgeProjectedPoint = tmp13;
    const candidate = tmp14;
    const candidateDist = tmp15;
    let found = -1;
    let minCandidateDistance = Number.MAX_VALUE;

    localCirclePosition
      .set(circleOffset)
      .itoLocalFrame(convexOffset, convexAngle);

    const vertices = convexShape.vertices;
    const normals = convexShape.axes;
    const numVertices = vertices.length;
    let normalIndex = -1;

    // Find the min separating edge
    let separation = -Number.MAX_VALUE;
    const radius = convexShape.boundingRadius + cr;

    for (let i = 0; i < numVertices; i++) {
      r.set(localCirclePosition).isub(vertices[i]);
      const s = normals[i].dot(r);

      if (s > radius) {
        return 0; // Early out
      }

      if (s > separation) {
        separation = s;
        normalIndex = i;
      }
    }

    // Check edges first
    for (
      let i = normalIndex + numVertices - 1;
      i < normalIndex + numVertices + 2;
      i++
    ) {
      const v0 = vertices[i % numVertices];
      const n = normals[i % numVertices];

      // Get point on circle closest to the convex
      candidate.set(n).imul(-cr).iadd(localCirclePosition);

      if (pointInConvexLocal(candidate, convexShape)) {
        candidateDist.set(v0).isub(candidate);
        const candidateDistance = Math.abs(candidateDist.dot(n));

        if (candidateDistance < minCandidateDistance) {
          minCandidateDistance = candidateDistance;
          found = i;
        }
      }
    }

    if (found !== -1) {
      if (justTest) {
        return 1;
      }

      const v0 = vertices[found % numVertices];
      const v1 = vertices[(found + 1) % numVertices];

      worldVertex0.set(v0).itoGlobalFrame(convexOffset, convexAngle);
      worldVertex1.set(v1).itoGlobalFrame(convexOffset, convexAngle);

      edge.set(worldVertex1).isub(worldVertex0);
      edgeUnit.set(edge).inormalize();

      // Get tangent (points out of the convex)
      normal.set(edgeUnit).irotate90cw();

      // Get point on circle closest to convex
      candidate.set(normal).imul(-cr).iadd(circleOffset);

      closestEdgeProjectedPoint
        .set(normal)
        .imul(minCandidateDistance)
        .iadd(candidate);

      const c = this.createContactEquation(
        circleBody,
        convexBody,
        circleShape,
        convexShape
      );

      c.normalA.set(candidate).isub(circleOffset);
      c.normalA.inormalize();

      c.contactPointA.set(c.normalA).imul(cr);
      c.contactPointA.iadd(circleOffset).isub(circleBody.position);

      c.contactPointB.set(closestEdgeProjectedPoint).isub(convexOffset);
      c.contactPointB.iadd(convexOffset).isub(convexBody.position);

      this.contactEquations.push(c);

      if (this.enableFriction) {
        this.frictionEquations.push(this.createFrictionFromContact(c));
      }

      return 1;
    }

    // Check closest vertices
    if (cr > 0 && normalIndex !== -1) {
      for (
        let i = normalIndex + numVertices;
        i < normalIndex + numVertices + 2;
        i++
      ) {
        const localVertex = vertices[i % numVertices];

        dist.set(localVertex).isub(localCirclePosition);

        if (dist.squaredMagnitude < cr * cr) {
          if (justTest) {
            return 1;
          }

          worldVertex
            .set(localVertex)
            .itoGlobalFrame(convexOffset, convexAngle);
          dist.set(worldVertex).isub(circleOffset);

          const c = this.createContactEquation(
            circleBody,
            convexBody,
            circleShape,
            convexShape
          );

          c.normalA.set(dist);
          c.normalA.inormalize();

          c.contactPointA.set(c.normalA).imul(cr);
          c.contactPointA.iadd(circleOffset).isub(circleBody.position);

          c.contactPointB.set(worldVertex).isub(convexOffset);
          c.contactPointB.iadd(convexOffset).isub(convexBody.position);

          this.contactEquations.push(c);

          if (this.enableFriction) {
            this.frictionEquations.push(this.createFrictionFromContact(c));
          }

          return 1;
        }
      }
    }

    return 0;
  }

  /**
   * Plane/Convex collision
   */
  planeConvex(
    planeBody: Body,
    planeShape: Shape,
    planeOffset: V2d,
    planeAngle: number,
    convexBody: Body,
    convexShape: Convex,
    convexOffset: V2d,
    convexAngle: number,
    justTest?: boolean
  ): number {
    const worldVertex = tmp1;
    const worldNormal = tmp2;
    const dist = tmp3;
    const localPlaneOffset = tmp4;
    const localPlaneNormal = tmp5;
    const localDist = tmp6;

    let numReported = 0;
    worldNormal.set(yAxis).irotate(planeAngle);

    // Get convex-local plane offset and normal
    localPlaneNormal.set(worldNormal).irotate(-convexAngle);
    localPlaneOffset.set(planeOffset).itoLocalFrame(convexOffset, convexAngle);

    const vertices = convexShape.vertices;
    for (let i = 0, numVerts = vertices.length; i !== numVerts; i++) {
      const v = vertices[i];

      localDist.set(v).isub(localPlaneOffset);

      if (localDist.dot(localPlaneNormal) <= 0) {
        if (justTest) {
          return 1;
        }

        worldVertex.set(v).itoGlobalFrame(convexOffset, convexAngle);

        dist.set(worldVertex).isub(planeOffset);

        numReported++;

        const c = this.createContactEquation(
          planeBody,
          convexBody,
          planeShape,
          convexShape
        );

        dist.set(worldVertex).isub(planeOffset);

        c.normalA.set(worldNormal);

        const d = dist.dot(c.normalA);
        dist.set(c.normalA).imul(d);

        // rj is from convex center to contact
        c.contactPointB.set(worldVertex).isub(convexBody.position);

        // ri is from plane center to contact
        c.contactPointA.set(worldVertex).isub(dist);
        c.contactPointA.isub(planeBody.position);

        this.contactEquations.push(c);

        if (!this.enableFrictionReduction) {
          if (this.enableFriction) {
            this.frictionEquations.push(this.createFrictionFromContact(c));
          }
        }
      }
    }

    if (this.enableFrictionReduction) {
      if (this.enableFriction && numReported) {
        this.frictionEquations.push(
          this.createFrictionFromAverage(numReported)
        );
      }
    }

    return numReported;
  }

  /**
   * Convex/Convex collision (SAT with edge clipping)
   */
  convexConvex(
    bodyA: Body,
    polyA: Convex,
    positionA: V2d,
    angleA: number,
    bodyB: Body,
    polyB: Convex,
    positionB: V2d,
    angleB: number,
    justTest?: boolean
  ): number {
    const totalRadius = 0;
    const dist = collidePolygons_dist;
    const tempVec = collidePolygons_tempVec;
    const tmpVec = collidePolygons_tmpVec;

    const edgeA = findMaxSeparation(
      tempVec,
      polyA,
      positionA,
      angleA,
      polyB,
      positionB,
      angleB
    );
    const separationA = tempVec[0];
    if (separationA > totalRadius) {
      return 0;
    }

    const edgeB = findMaxSeparation(
      tmpVec,
      polyB,
      positionB,
      angleB,
      polyA,
      positionA,
      angleA
    );
    const separationB = tmpVec[0];
    if (separationB > totalRadius) {
      return 0;
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
      position1 = positionB;
      angle1 = angleB;
      position2 = positionA;
      angle2 = angleA;
      edge1 = edgeB;
    } else {
      poly1 = polyA;
      poly2 = polyB;
      body1 = bodyA;
      body2 = bodyB;
      position1 = positionA;
      angle1 = angleA;
      position2 = positionB;
      angle2 = angleB;
      edge1 = edgeA;
    }

    const incidentEdge = collidePolygons_incidentEdge;
    findIncidentEdge(
      incidentEdge,
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

    const v11 = collidePolygons_v11;
    const v12 = collidePolygons_v12;
    v11.set(vertices1[iv1]);
    v12.set(vertices1[iv2]);

    const localTangent = collidePolygons_localTangent;
    localTangent.set(v12).isub(v11);
    localTangent.inormalize();

    const localNormal = collidePolygons_localNormal;
    localNormal.set(localTangent).icrossVZ(1.0);

    const planePoint = collidePolygons_planePoint;
    planePoint.set(v11).iadd(v12).imul(0.5);

    const tangent = collidePolygons_tangent;
    tangent.set(localTangent).irotate(angle1);

    const normal = collidePolygons_normal;
    normal.set(tangent).icrossVZ(1.0);

    v11.itoGlobalFrame(position1, angle1);
    v12.itoGlobalFrame(position1, angle1);

    // Face offset
    const frontOffset = normal.dot(v11);

    // Side offsets
    const sideOffset1 = -tangent.dot(v11) + totalRadius;
    const sideOffset2 = tangent.dot(v12) + totalRadius;

    // Clip incident edge
    const clipPoints1 = collidePolygons_clipPoints1;
    const clipPoints2 = collidePolygons_clipPoints2;
    let np = 0;

    // Clip to box side 1
    const negativeTangent = collidePolygons_negativeTangent;
    negativeTangent.set(tangent).imul(-1);
    np = clipSegmentToLine(
      clipPoints1,
      incidentEdge,
      negativeTangent,
      sideOffset1
    );

    if (np < 2) {
      return 0;
    }

    // Clip to negative box side 1
    np = clipSegmentToLine(clipPoints2, clipPoints1, tangent, sideOffset2);

    if (np < 2) {
      return 0;
    }

    let pointCount = 0;
    for (let i = 0; i < maxManifoldPoints; i++) {
      const separation = normal.dot(clipPoints2[i]) - frontOffset;

      if (separation <= totalRadius) {
        if (justTest) {
          return 1;
        }

        pointCount++;

        const c = this.createContactEquation(body1, body2, poly1, poly2);

        c.normalA.set(normal);
        c.contactPointB.set(clipPoints2[i]);
        c.contactPointB.isub(body2.position);

        dist.set(normal).imul(-separation);
        c.contactPointA.set(clipPoints2[i]).iadd(dist);
        c.contactPointA.isub(body1.position);

        this.contactEquations.push(c);

        if (this.enableFriction && !this.enableFrictionReduction) {
          this.frictionEquations.push(this.createFrictionFromContact(c));
        }
      }
    }

    if (pointCount && this.enableFrictionReduction && this.enableFriction) {
      this.frictionEquations.push(this.createFrictionFromAverage(pointCount));
    }

    return pointCount;
  }

  /**
   * Convex/Capsule collision
   */
  convexCapsule(
    convexBody: Body,
    convexShape: Convex,
    convexPosition: V2d,
    convexAngle: number,
    capsuleBody: Body,
    capsuleShape: Capsule,
    capsulePosition: V2d,
    capsuleAngle: number,
    justTest?: boolean
  ): number {
    const circlePos = convexCapsule_tempVec;
    const halfLength = capsuleShape.length / 2;

    // Check the end circles
    circlePos.set(halfLength, 0).itoGlobalFrame(capsulePosition, capsuleAngle);
    const result1 = this.circleConvex(
      capsuleBody,
      capsuleShape as any,
      circlePos,
      capsuleAngle,
      convexBody,
      convexShape,
      convexPosition,
      convexAngle,
      justTest,
      capsuleShape.radius
    );

    circlePos.set(-halfLength, 0).itoGlobalFrame(capsulePosition, capsuleAngle);
    const result2 = this.circleConvex(
      capsuleBody,
      capsuleShape as any,
      circlePos,
      capsuleAngle,
      convexBody,
      convexShape,
      convexPosition,
      convexAngle,
      justTest,
      capsuleShape.radius
    );

    if (justTest && result1 + result2 !== 0) {
      return 1;
    }

    // Check center rect
    const r = convexCapsule_tempRect;
    setConvexToCapsuleShapeMiddle(r, capsuleShape);
    const result = this.convexConvex(
      convexBody,
      convexShape,
      convexPosition,
      convexAngle,
      capsuleBody,
      r,
      capsulePosition,
      capsuleAngle,
      justTest
    );

    return result + result1 + result2;
  }

  /**
   * Capsule/Capsule collision
   */
  capsuleCapsule(
    bodyA: Body,
    shapeA: Capsule,
    positionA: V2d,
    angleA: number,
    bodyB: Body,
    shapeB: Capsule,
    positionB: V2d,
    angleB: number,
    justTest?: boolean
  ): number {
    let enableFrictionBefore: boolean | undefined;
    const circlePosA = capsuleCapsule_tempVec1;
    const circlePosB = capsuleCapsule_tempVec2;

    let numContacts = 0;

    // Need 4 circle checks between all endpoints
    for (let i = 0; i < 2; i++) {
      circlePosA
        .set((i === 0 ? -1 : 1) * (shapeA.length / 2), 0)
        .itoGlobalFrame(positionA, angleA);

      for (let j = 0; j < 2; j++) {
        circlePosB
          .set((j === 0 ? -1 : 1) * (shapeB.length / 2), 0)
          .itoGlobalFrame(positionB, angleB);

        if (this.enableFrictionReduction) {
          enableFrictionBefore = this.enableFriction;
          this.enableFriction = false;
        }

        const result = this.circleCircle(
          bodyA,
          shapeA as any,
          circlePosA,
          angleA,
          bodyB,
          shapeB as any,
          circlePosB,
          angleB,
          justTest,
          shapeA.radius,
          shapeB.radius
        );

        if (this.enableFrictionReduction) {
          this.enableFriction = enableFrictionBefore!;
        }

        if (justTest && result !== 0) {
          return 1;
        }

        numContacts += result;
      }
    }

    // Check circles against center boxes
    if (this.enableFrictionReduction) {
      enableFrictionBefore = this.enableFriction;
      this.enableFriction = false;
    }

    const rect = capsuleCapsule_tempRect1;
    setConvexToCapsuleShapeMiddle(rect, shapeA);
    const result1 = this.convexCapsule(
      bodyA,
      rect,
      positionA,
      angleA,
      bodyB,
      shapeB,
      positionB,
      angleB,
      justTest
    );

    if (this.enableFrictionReduction) {
      this.enableFriction = enableFrictionBefore!;
    }

    if (justTest && result1 !== 0) {
      return 1;
    }
    numContacts += result1;

    if (this.enableFrictionReduction) {
      enableFrictionBefore = this.enableFriction;
      this.enableFriction = false;
    }

    setConvexToCapsuleShapeMiddle(rect, shapeB);
    const result2 = this.convexCapsule(
      bodyB,
      rect,
      positionB,
      angleB,
      bodyA,
      shapeA,
      positionA,
      angleA,
      justTest
    );

    if (this.enableFrictionReduction) {
      this.enableFriction = enableFrictionBefore!;
    }

    if (justTest && result2 !== 0) {
      return 1;
    }
    numContacts += result2;

    if (this.enableFrictionReduction) {
      if (numContacts && this.enableFriction) {
        this.frictionEquations.push(
          this.createFrictionFromAverage(numContacts)
        );
      }
    }

    return numContacts;
  }

  /**
   * Circle/Heightfield collision
   */
  circleHeightfield(
    circleBody: Body,
    circleShape: Circle,
    circlePos: V2d,
    _circleAngle: number,
    hfBody: Body,
    hfShape: Heightfield,
    hfPos: V2d,
    _hfAngle: number,
    justTest?: boolean,
    radius?: number
  ): number {
    const data = hfShape.heights;
    const r = radius ?? circleShape.radius;
    const w = hfShape.elementWidth;
    const dist = circleHeightfield_dist;
    const candidate = circleHeightfield_candidate;
    const minCandidate = circleHeightfield_minCandidate;
    const minCandidateNormal = circleHeightfield_minCandidateNormal;
    const worldNormal = circleHeightfield_worldNormal;
    const v0 = circleHeightfield_v0;
    const v1 = circleHeightfield_v1;

    // Get the index of the points to test against
    let idxA = Math.floor((circlePos[0] - r - hfPos[0]) / w);
    let idxB = Math.ceil((circlePos[0] + r - hfPos[0]) / w);

    if (idxA < 0) {
      idxA = 0;
    }
    if (idxB >= data.length) {
      idxB = data.length - 1;
    }

    // Get max and min
    let max = data[idxA];
    let min = data[idxB];
    for (let i = idxA; i < idxB; i++) {
      if (data[i] < min) {
        min = data[i];
      }
      if (data[i] > max) {
        max = data[i];
      }
    }

    if (circlePos[1] - r > max) {
      return 0;
    }

    let found = false;

    // Check all edges
    for (let i = idxA; i < idxB; i++) {
      v0.set(i * w, data[i]);
      v1.set((i + 1) * w, data[i + 1]);
      v0.iadd(hfPos);
      v1.iadd(hfPos);

      // Get normal
      worldNormal.set(v1).isub(v0);
      worldNormal.irotate(Math.PI / 2);
      worldNormal.inormalize();

      // Get point on circle closest to the edge
      candidate.set(worldNormal).imul(-r).iadd(circlePos);

      // Distance from v0 to candidate point
      dist.set(candidate).isub(v0);

      // Check if it is in the element "stick"
      const d = dist.dot(worldNormal);
      if (candidate[0] >= v0[0] && candidate[0] < v1[0] && d <= 0) {
        if (justTest) {
          return 1;
        }

        found = true;

        // Store the candidate point, projected to the edge
        dist.set(worldNormal).imul(-d);
        minCandidate.set(candidate).iadd(dist);
        minCandidateNormal.set(worldNormal);

        const c = this.createContactEquation(
          hfBody,
          circleBody,
          hfShape,
          circleShape
        );

        c.normalA.set(minCandidateNormal);

        c.contactPointB.set(c.normalA).imul(-r);
        c.contactPointB.iadd(circlePos).isub(circleBody.position);

        c.contactPointA.set(minCandidate);
        c.contactPointA.isub(hfBody.position);

        this.contactEquations.push(c);

        if (this.enableFriction) {
          this.frictionEquations.push(this.createFrictionFromContact(c));
        }
      }
    }

    // Check all vertices
    found = false;
    if (r > 0) {
      for (let i = idxA; i <= idxB; i++) {
        v0.set(i * w, data[i]);
        v0.iadd(hfPos);

        dist.set(circlePos).isub(v0);

        if (dist.squaredMagnitude < r * r) {
          if (justTest) {
            return 1;
          }

          found = true;

          const c = this.createContactEquation(
            hfBody,
            circleBody,
            hfShape,
            circleShape
          );

          c.normalA.set(dist);
          c.normalA.inormalize();

          c.contactPointB.set(c.normalA).imul(-r);
          c.contactPointB.iadd(circlePos).isub(circleBody.position);

          c.contactPointA.set(v0).isub(hfPos);
          c.contactPointA.iadd(hfPos).isub(hfBody.position);

          this.contactEquations.push(c);

          if (this.enableFriction) {
            this.frictionEquations.push(this.createFrictionFromContact(c));
          }
        }
      }
    }

    if (found) {
      return 1;
    }

    return 0;
  }

  /**
   * Convex/Heightfield collision
   */
  convexHeightfield(
    convexBody: Body,
    convexShape: Convex,
    convexPos: V2d,
    convexAngle: number,
    hfBody: Body,
    hfShape: Heightfield,
    hfPos: V2d,
    _hfAngle: number,
    justTest?: boolean
  ): number {
    const data = hfShape.heights;
    const w = hfShape.elementWidth;
    const v0 = convexHeightfield_v0;
    const v1 = convexHeightfield_v1;
    const tilePos = convexHeightfield_tilePos;
    const tileConvex = convexHeightfield_tempConvexShape;

    // Use body's AABB to get index range
    const aabb = convexBody.aabb;
    let idxA = Math.floor((aabb.lowerBound[0] - hfPos[0]) / w);
    let idxB = Math.ceil((aabb.upperBound[0] - hfPos[0]) / w);

    if (idxA < 0) {
      idxA = 0;
    }
    if (idxB >= data.length) {
      idxB = data.length - 1;
    }

    // Get max and min
    let max = data[idxA];
    let min = data[idxB];
    for (let i = idxA; i < idxB; i++) {
      if (data[i] < min) {
        min = data[i];
      }
      if (data[i] > max) {
        max = data[i];
      }
    }

    if (aabb.lowerBound[1] > max) {
      return 0;
    }

    let numContacts = 0;

    // Loop over all edges
    for (let i = idxA; i < idxB; i++) {
      v0.set(i * w, data[i]);
      v1.set((i + 1) * w, data[i + 1]);
      v0.iadd(hfPos);
      v1.iadd(hfPos);

      // Construct a convex tile
      const tileHeight = 100;
      tilePos.set((v1[0] + v0[0]) * 0.5, (v1[1] + v0[1] - tileHeight) * 0.5);

      tileConvex.vertices[0].set(v1).isub(tilePos);
      tileConvex.vertices[1].set(v0).isub(tilePos);
      tileConvex.vertices[2].set(tileConvex.vertices[1]);
      tileConvex.vertices[3].set(tileConvex.vertices[0]);
      tileConvex.vertices[2][1] -= tileHeight;
      tileConvex.vertices[3][1] -= tileHeight;

      // Update normals for the tile
      for (let j = 0; j < 4; j++) {
        const v0j = tileConvex.vertices[j];
        const v1j = tileConvex.vertices[(j + 1) % 4];
        tileConvex.axes[j].set(v1j).isub(v0j);
        tileConvex.axes[j].irotate90cw();
        tileConvex.axes[j].inormalize();
      }

      // Do convex collision
      numContacts += this.convexConvex(
        convexBody,
        convexShape,
        convexPos,
        convexAngle,
        hfBody,
        tileConvex,
        tilePos,
        0,
        justTest
      );
    }

    return numContacts;
  }

  // ========== NOT IMPLEMENTED (return 0) ==========

  lineLine(): number {
    return 0;
  }

  lineBox(): number {
    return 0;
  }

  lineCapsule(): number {
    return 0;
  }

  convexLine(): number {
    return 0;
  }
}
