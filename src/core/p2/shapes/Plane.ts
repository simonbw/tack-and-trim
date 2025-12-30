import Shape, { ShapeOptions } from "./Shape";
import vec2, { Vec2 } from "../math/vec2";
import type AABB from "../collision/AABB";
import type RaycastResult from "../collision/RaycastResult";
import type Ray from "../collision/Ray";

const intersectPlane_planePointToFrom = vec2.create();
const intersectPlane_normal = vec2.create();
const intersectPlane_len = vec2.create();

/**
 * Plane shape class. The plane is facing in the Y direction.
 */
export default class Plane extends Shape {
  constructor(options: ShapeOptions = {}) {
    const opts = { ...options, type: Shape.PLANE };
    super(opts);
    this.updateBoundingRadius();
    this.updateArea();
  }

  computeMomentOfInertia(_mass: number): number {
    return 0; // Plane is infinite
  }

  updateBoundingRadius(): void {
    this.boundingRadius = Number.MAX_VALUE;
  }

  computeAABB(out: AABB, _position: Vec2, angle: number): void {
    const a = angle % (2 * Math.PI);
    const set = vec2.set;
    const max = 1e7;
    const lowerBound = out.lowerBound;
    const upperBound = out.upperBound;

    // Set max bounds
    set(lowerBound, -max, -max);
    set(upperBound, max, max);

    if (a === 0) {
      upperBound[1] = 0;
    } else if (a === Math.PI / 2) {
      lowerBound[0] = 0;
    } else if (a === Math.PI) {
      lowerBound[1] = 0;
    } else if (a === (3 * Math.PI) / 2) {
      upperBound[0] = 0;
    }
  }

  updateArea(): void {
    this.area = Number.MAX_VALUE;
  }

  raycast(result: RaycastResult, ray: Ray, position: Vec2, angle: number): void {
    const from = ray.from;
    const to = ray.to;
    const direction = ray.direction;
    const planePointToFrom = intersectPlane_planePointToFrom;
    const normal = intersectPlane_normal;
    const len = intersectPlane_len;

    // Get plane normal
    vec2.set(normal, 0, 1);
    vec2.rotate(normal, normal, angle);

    vec2.sub(len, from, position);
    const planeToFrom = vec2.dot(len, normal);
    vec2.sub(len, to, position);
    const planeToTo = vec2.dot(len, normal);

    if (planeToFrom * planeToTo > 0) {
      // "from" and "to" are on the same side of the plane
      return;
    }

    if (vec2.squaredDistance(from, to) < planeToFrom * planeToFrom) {
      return;
    }

    const n_dot_dir = vec2.dot(normal, direction);

    vec2.sub(planePointToFrom, from, position);
    const t = -vec2.dot(normal, planePointToFrom) / n_dot_dir / ray.length;

    ray.reportIntersection(result, t, normal, -1);
  }
}
