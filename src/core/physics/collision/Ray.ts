import { CompatibleVector, V, V2d } from "../../Vector";
import type Body from "../body/Body";
import type Shape from "../shapes/Shape";
import type AABB from "./AABB";
import type RaycastResult from "./RaycastResult";

export interface RayOptions {
  from?: CompatibleVector;
  to?: CompatibleVector;
  checkCollisionResponse?: boolean;
  skipBackfaces?: boolean;
  collisionMask?: number;
  collisionGroup?: number;
  mode?: number;
  callback?: (result: RaycastResult) => void;
}

function distanceFromIntersectionSquared(
  from: V2d,
  direction: V2d,
  position: V2d
): number {
  // v0 is vector from from to position
  const v0 = position.sub(from);
  const dot = v0.dot(direction);

  // intersect = direction * dot + from
  const intersect = direction.mul(dot).add(from);

  return position.squaredDistanceTo(intersect);
}

/**
 * A line with a start and end point that is used to intersect shapes.
 */
export default class Ray {
  static readonly CLOSEST = 1;
  static readonly ANY = 2;
  static readonly ALL = 4;

  from: V2d;
  to: V2d;
  checkCollisionResponse: boolean;
  skipBackfaces: boolean;
  collisionMask: number;
  collisionGroup: number;
  mode: number;
  callback: (result: RaycastResult) => void;
  direction: V2d;
  length: number;

  _currentBody: Body | null = null;
  _currentShape: Shape | null = null;

  constructor(options: RayOptions = {}) {
    this.from = options.from
      ? V(options.from[0], options.from[1])
      : V();

    this.to = options.to
      ? V(options.to[0], options.to[1])
      : V();

    this.checkCollisionResponse = options.checkCollisionResponse ?? true;
    this.skipBackfaces = options.skipBackfaces ?? false;
    this.collisionMask = options.collisionMask ?? -1;
    this.collisionGroup = options.collisionGroup ?? -1;
    this.mode = options.mode ?? Ray.ANY;
    this.callback = options.callback ?? ((_result: RaycastResult) => {});

    this.direction = V();
    this.length = 1;

    this.update();
  }

  /**
   * Should be called if you change the from or to point.
   */
  update(): void {
    const d = this.direction;
    d.set(this.to).isub(this.from);
    this.length = d.magnitude;
    d.inormalize();
  }

  /**
   * Intersect multiple bodies
   */
  intersectBodies(result: RaycastResult, bodies: Body[]): void {
    for (let i = 0, l = bodies.length; !result.shouldStop(this) && i < l; i++) {
      const body = bodies[i];
      const aabb = body.getAABB();
      if (aabb.overlapsRay(this) >= 0 || aabb.containsPoint(this.from)) {
        this.intersectBody(result, body);
      }
    }
  }

  /**
   * Shoot a ray at a body, get back information about the hit.
   */
  intersectBody(result: RaycastResult, body: Body): void {
    const checkCollisionResponse = this.checkCollisionResponse;

    if (checkCollisionResponse && !body.collisionResponse) {
      return;
    }

    for (let i = 0, N = body.shapes.length; i < N; i++) {
      const shape = body.shapes[i];

      if (checkCollisionResponse && !shape.collisionResponse) {
        continue;
      }

      if (
        (this.collisionGroup & shape.collisionMask) === 0 ||
        (shape.collisionGroup & this.collisionMask) === 0
      ) {
        continue;
      }

      // Get world angle and position of the shape
      const worldPosition = V(shape.position).irotate(body.angle).iadd(body.position);
      const worldAngle = shape.angle + body.angle;

      this.intersectShape(result, shape, worldAngle, worldPosition, body);

      if (result.shouldStop(this)) {
        break;
      }
    }
  }

  /**
   * @private
   */
  intersectShape(
    result: RaycastResult,
    shape: Shape,
    angle: number,
    position: V2d,
    body: Body
  ): void {
    const from = this.from;

    // Checking radius
    const distance = distanceFromIntersectionSquared(
      from,
      this.direction,
      position
    );
    if (distance > shape.boundingRadius * shape.boundingRadius) {
      return;
    }

    this._currentBody = body;
    this._currentShape = shape;

    shape.raycast(result, this, position, angle);

    this._currentBody = this._currentShape = null;
  }

  /**
   * Get the AABB of the ray.
   */
  getAABB(result: AABB): void {
    const to = this.to;
    const from = this.from;
    result.lowerBound.set(Math.min(to[0], from[0]), Math.min(to[1], from[1]));
    result.upperBound.set(Math.max(to[0], from[0]), Math.max(to[1], from[1]));
  }

  /**
   * @private
   */
  reportIntersection(
    result: RaycastResult,
    fraction: number,
    normal: V2d,
    faceIndex: number
  ): void {
    const shape = this._currentShape!;
    const body = this._currentBody!;

    // Skip back faces?
    if (this.skipBackfaces && normal.dot(this.direction) > 0) {
      return;
    }

    switch (this.mode) {
      case Ray.ALL:
        result.set(normal, shape, body, fraction, faceIndex);
        this.callback(result);
        break;

      case Ray.CLOSEST:
        // Store if closer than current closest
        if (!result.hasHit() || fraction < result.fraction!) {
          result.set(normal, shape, body, fraction, faceIndex);
        }
        break;

      case Ray.ANY:
        // Report and stop.
        result.set(normal, shape, body, fraction, faceIndex);
        break;
    }
  }
}
