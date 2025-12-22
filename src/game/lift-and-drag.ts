import p2, { Convex } from "p2";
import { V, V2d } from "../core/Vector";

const GLOBAL_DRAG = 0.01;
const GLOBAL_LIFT = 0.01;

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
  // calculate some numbers relating to the edge
  const v1World = V(0, 0);
  const v2World = V(0, 0);
  body.toWorldFrame(v1World, v1);
  body.toWorldFrame(v2World, v2);
  const midpoint = v1World.add(v2World).imul(0.5);

  const edge = v2World.sub(v1World);
  const edgeLength = edge.magnitude;
  edge.inormalize(); // edge is normalized
  const edgeNormal = edge.rotate90cw(); // vector pointing out of the rectangle

  const fluidVelocity = V(body.velocity);
  const fluidSpeed = fluidVelocity.magnitude;
  fluidVelocity.inormalize();

  const fluidDotEdgeNormal = p2.vec2.dot(fluidVelocity, edgeNormal);
  const fluidDotEdge = p2.vec2.dot(fluidVelocity, edge);
  if (fluidDotEdgeNormal < 0) {
    return;
  }

  const dragMagnitude =
    fluidDotEdgeNormal *
    edgeLength *
    fluidSpeed *
    fluidSpeed *
    dragAmount *
    GLOBAL_DRAG;
  const drag = fluidVelocity.mul(-dragMagnitude);
  body.applyForce(drag, midpoint.sub(body.position));

  const liftMagnitude =
    fluidDotEdge *
    fluidDotEdgeNormal *
    edgeLength *
    fluidSpeed *
    fluidSpeed *
    liftAmount *
    GLOBAL_LIFT;
  const lift = fluidVelocity.rotate90cw().imul(-liftMagnitude);
  body.applyForce(lift, midpoint.sub(body.position));
}
