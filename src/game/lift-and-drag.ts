import p2, { Convex } from "p2";
import { V, V2d } from "../core/Vector";

const GLOBAL_DRAG = 0.005;
const GLOBAL_LIFT = 0.005;

export function applyLiftAndDragToBody(
  body: p2.Body,
  liftAmount: number = 1.0,
  dragAmount: number = 1.0
) {
  for (const shape of body.shapes) {
    if (shape instanceof Convex) {
      for (let i = 0; i < shape.vertices.length; i++) {
        const v1 = V(shape.vertices[i]);
        const v2 = V(shape.vertices[(i + 1) % shape.vertices.length]);
        applyLiftAndDragToEdge(body, v1, v2, liftAmount, dragAmount);
      }
    }
  }
}

export function applyLiftAndDragToEdge(
  body: p2.Body,
  v1: V2d,
  v2: V2d,
  liftAmount: number = 1.0,
  dragAmount: number = 1.0
) {
  const v1World = V(0, 0);
  const v2World = V(0, 0);
  body.toWorldFrame(v1World, v1);
  body.toWorldFrame(v2World, v2);

  const edge = v2World.sub(v1World);
  const edgeLength = edge.magnitude;
  edge.inormalize();
  const edgeNormal = edge.rotate90cw();

  // Sample at both endpoints for better accuracy with rotation.
  // Each endpoint is responsible for half the edge length.
  const halfLength = edgeLength / 2;
  applyLiftAndDragAtPoint(body, v1World, edge, edgeNormal, halfLength, liftAmount, dragAmount);
  applyLiftAndDragAtPoint(body, v2World, edge, edgeNormal, halfLength, liftAmount, dragAmount);
}

function applyLiftAndDragAtPoint(
  body: p2.Body,
  point: V2d,
  edge: V2d,
  edgeNormal: V2d,
  edgeLength: number,
  liftAmount: number,
  dragAmount: number
) {
  const r = point.sub(V(body.position));
  const pointVelocity = V(body.velocity).add(r.rotate90ccw().mul(body.angularVelocity));
  const pointSpeed = pointVelocity.magnitude;
  if (pointSpeed < 0.0001) return;
  pointVelocity.inormalize();

  const velDotNormal = p2.vec2.dot(pointVelocity, edgeNormal);
  const velDotEdge = p2.vec2.dot(pointVelocity, edge);
  if (velDotNormal < 0) return;

  const dragMagnitude =
    velDotNormal * edgeLength * pointSpeed * pointSpeed * dragAmount * GLOBAL_DRAG;
  const drag = pointVelocity.mul(-dragMagnitude);
  body.applyForce(drag, r);

  const liftMagnitude =
    velDotEdge * velDotNormal * edgeLength * pointSpeed * pointSpeed * liftAmount * GLOBAL_LIFT;
  const lift = pointVelocity.rotate90cw().imul(-liftMagnitude);
  body.applyForce(lift, r);
}
