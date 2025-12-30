import vec2, { Vec2 } from "../math/vec2";
import type RaycastResult from "./RaycastResult";
import type Shape from "../shapes/Shape";
import type AABB from "./AABB";
import type Body from "../objects/Body";

export interface RayOptions {
  from?: Vec2;
  to?: Vec2;
  checkCollisionResponse?: boolean;
  skipBackfaces?: boolean;
  collisionMask?: number;
  collisionGroup?: number;
  mode?: number;
  callback?: (result: RaycastResult) => void;
}

const intersectBody_worldPosition = vec2.create();
const hitPointWorld = vec2.create();
const v0 = vec2.create();
const intersect = vec2.create();

function distanceFromIntersectionSquared(
  from: Vec2,
  direction: Vec2,
  position: Vec2
): number {
  // v0 is vector from from to position
  vec2.sub(v0, position, from);
  const dot = vec2.dot(v0, direction);

  // intersect = direction * dot + from
  vec2.scale(intersect, direction, dot);
  vec2.add(intersect, intersect, from);

  return vec2.squaredDistance(position, intersect);
}

/**
 * A line with a start and end point that is used to intersect shapes.
 */
export default class Ray {
  static readonly CLOSEST = 1;
  static readonly ANY = 2;
  static readonly ALL = 4;

  from: Vec2;
  to: Vec2;
  checkCollisionResponse: boolean;
  skipBackfaces: boolean;
  collisionMask: number;
  collisionGroup: number;
  mode: number;
  callback: (result: RaycastResult) => void;
  direction: Vec2;
  length: number;

  _currentBody: Body | null = null;
  _currentShape: Shape | null = null;

  constructor(options: RayOptions = {}) {
    this.from = options.from
      ? vec2.fromValues(options.from[0], options.from[1])
      : vec2.create();

    this.to = options.to
      ? vec2.fromValues(options.to[0], options.to[1])
      : vec2.create();

    this.checkCollisionResponse = options.checkCollisionResponse ?? true;
    this.skipBackfaces = options.skipBackfaces ?? false;
    this.collisionMask = options.collisionMask ?? -1;
    this.collisionGroup = options.collisionGroup ?? -1;
    this.mode = options.mode ?? Ray.ANY;
    this.callback = options.callback ?? ((_result: RaycastResult) => {});

    this.direction = vec2.create();
    this.length = 1;

    this.update();
  }

  /**
   * Should be called if you change the from or to point.
   */
  update(): void {
    const d = this.direction;
    vec2.sub(d, this.to, this.from);
    this.length = vec2.length(d);
    vec2.normalize(d, d);
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

    const worldPosition = intersectBody_worldPosition;

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
      vec2.rotate(worldPosition, shape.position, body.angle);
      vec2.add(worldPosition, worldPosition, body.position);
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
    position: Vec2,
    body: Body
  ): void {
    const from = this.from;

    // Checking radius
    const distance = distanceFromIntersectionSquared(from, this.direction, position);
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
    vec2.set(
      result.lowerBound,
      Math.min(to[0], from[0]),
      Math.min(to[1], from[1])
    );
    vec2.set(
      result.upperBound,
      Math.max(to[0], from[0]),
      Math.max(to[1], from[1])
    );
  }

  /**
   * @private
   */
  reportIntersection(
    result: RaycastResult,
    fraction: number,
    normal: Vec2,
    faceIndex: number
  ): void {
    const shape = this._currentShape!;
    const body = this._currentBody!;

    // Skip back faces?
    if (this.skipBackfaces && vec2.dot(normal, this.direction) > 0) {
      return;
    }

    switch (this.mode) {
      case Ray.ALL:
        result.set(normal, shape, body, fraction, faceIndex);
        this.callback(result);
        break;

      case Ray.CLOSEST:
        // Store if closer than current closest
        if (fraction < result.fraction || !result.hasHit()) {
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
