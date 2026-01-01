import Shape, { ShapeOptions } from "./Shape";
import { V, V2d } from "../../Vector";
import AABB from "../collision/AABB";
import type RaycastResult from "../collision/raycast/RaycastResult";
import type Ray from "../collision/raycast/Ray";

export interface CircleOptions extends ShapeOptions {
  radius?: number;
}

const Ray_intersectSphere_intersectionPoint = V();
const Ray_intersectSphere_normal = V();

/**
 * Circle shape class.
 */
export default class Circle extends Shape {
  radius: number;

  constructor(options: CircleOptions = {}) {
    super(options);
    this.radius = options.radius ?? 1;
    this.updateBoundingRadius();
    this.updateArea();
  }

  computeMomentOfInertia(mass: number): number {
    const r = this.radius;
    return (mass * r * r) / 2;
  }

  updateBoundingRadius(): void {
    this.boundingRadius = this.radius;
  }

  updateArea(): void {
    this.area = Math.PI * this.radius * this.radius;
  }

  computeAABB(position: V2d, _angle: number): AABB {
    const r = this.radius;
    const out = new AABB();
    out.upperBound.set(r, r);
    out.lowerBound.set(-r, -r);
    if (position) {
      out.lowerBound.iadd(position);
      out.upperBound.iadd(position);
    }
    return out;
  }

  raycast(result: RaycastResult, ray: Ray, position: V2d, _angle: number): void {
    const from = ray.from;
    const to = ray.to;
    const r = this.radius;

    const a =
      Math.pow(to[0] - from[0], 2) + Math.pow(to[1] - from[1], 2);
    const b =
      2 *
      ((to[0] - from[0]) * (from[0] - position[0]) +
        (to[1] - from[1]) * (from[1] - position[1]));
    const c =
      Math.pow(from[0] - position[0], 2) +
      Math.pow(from[1] - position[1], 2) -
      Math.pow(r, 2);
    const delta = Math.pow(b, 2) - 4 * a * c;

    const intersectionPoint = Ray_intersectSphere_intersectionPoint;
    const normal = Ray_intersectSphere_normal;

    if (delta < 0) {
      // No intersection
      return;
    } else if (delta === 0) {
      // single intersection point
      intersectionPoint.set(from).ilerp(to, delta);

      normal.set(intersectionPoint).isub(position);
      normal.inormalize();

      ray.reportIntersection(result, delta, normal, -1);
    } else {
      const sqrtDelta = Math.sqrt(delta);
      const inv2a = 1 / (2 * a);
      const d1 = (-b - sqrtDelta) * inv2a;
      const d2 = (-b + sqrtDelta) * inv2a;

      if (d1 >= 0 && d1 <= 1) {
        intersectionPoint.set(from).ilerp(to, d1);

        normal.set(intersectionPoint).isub(position);
        normal.inormalize();

        ray.reportIntersection(result, d1, normal, -1);

        if (result.shouldStop(ray)) {
          return;
        }
      }

      if (d2 >= 0 && d2 <= 1) {
        intersectionPoint.set(from).ilerp(to, d2);

        normal.set(intersectionPoint).isub(position);
        normal.inormalize();

        ray.reportIntersection(result, d2, normal, -1);
      }
    }
  }
}
