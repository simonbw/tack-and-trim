import p2, { Convex } from "p2";
import { V, V2d } from "../core/Vector";

const GLOBAL_DRAG = 0.005;
const GLOBAL_LIFT = 0.005;

type FluidVelocityFn = (point: V2d) => V2d;
const defaultFluidVelocity: FluidVelocityFn = () => V(0, 0);

export function applyLiftAndDragToBody(
  body: p2.Body,
  liftAmount: number = 1.0,
  dragAmount: number = 1.0,
  getFluidVelocity: FluidVelocityFn = defaultFluidVelocity
) {
  for (const shape of body.shapes) {
    if (shape instanceof Convex) {
      for (let i = 0; i < shape.vertices.length; i++) {
        const v1 = V(shape.vertices[i]);
        const v2 = V(shape.vertices[(i + 1) % shape.vertices.length]);
        applyLiftAndDragToEdge(
          body,
          v1,
          v2,
          liftAmount,
          dragAmount,
          getFluidVelocity
        );
      }
    }
  }
}

export function applyLiftAndDragToEdge(
  body: p2.Body,
  v1: V2d,
  v2: V2d,
  liftAmount: number = 1.0,
  dragAmount: number = 1.0,
  getFluidVelocity: FluidVelocityFn = defaultFluidVelocity
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
  applyLiftAndDragAtPoint(
    body,
    v1World,
    edge,
    edgeNormal,
    halfLength,
    liftAmount,
    dragAmount,
    getFluidVelocity
  );
  applyLiftAndDragAtPoint(
    body,
    v2World,
    edge,
    edgeNormal,
    halfLength,
    liftAmount,
    dragAmount,
    getFluidVelocity
  );
}

function applyLiftAndDragAtPoint(
  body: p2.Body,
  point: V2d,
  edge: V2d,
  edgeNormal: V2d,
  edgeLength: number,
  liftAmount: number,
  dragAmount: number,
  getFluidVelocity: FluidVelocityFn
) {
  const r = point.sub(V(body.position));
  const pointVelocity = V(body.velocity).add(
    r.rotate90ccw().mul(body.angularVelocity)
  );
  const fluidVelocity = getFluidVelocity(point);
  const relativeVelocity = pointVelocity.sub(fluidVelocity);

  const relativeSpeed = relativeVelocity.magnitude;
  if (relativeSpeed < 0.0001) return;
  relativeVelocity.inormalize();

  const velDotNormal = p2.vec2.dot(relativeVelocity, edgeNormal);
  const velDotEdge = p2.vec2.dot(relativeVelocity, edge);
  if (velDotNormal < 0) return;

  const dragMagnitude =
    velDotNormal *
    edgeLength *
    relativeSpeed *
    relativeSpeed *
    dragAmount *
    GLOBAL_DRAG;
  const drag = relativeVelocity.mul(-dragMagnitude);
  body.applyForce(drag, r);

  const liftMagnitude =
    velDotEdge *
    velDotNormal *
    edgeLength *
    relativeSpeed *
    relativeSpeed *
    liftAmount *
    GLOBAL_LIFT;
  const lift = relativeVelocity.rotate90cw().imul(-liftMagnitude);
  body.applyForce(lift, r);
}
