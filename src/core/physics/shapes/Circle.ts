import Shape, { ShapeOptions } from "./Shape";
import vec2, { Vec2 } from "../math/vec2";
import type AABB from "../collision/AABB";
import type RaycastResult from "../collision/RaycastResult";
import type Ray from "../collision/Ray";

export interface CircleOptions extends ShapeOptions {
  radius?: number;
}

const Ray_intersectSphere_intersectionPoint = vec2.create();
const Ray_intersectSphere_normal = vec2.create();

/**
 * Circle shape class.
 */
export default class Circle extends Shape {
  radius: number;

  constructor(options: CircleOptions = {}) {
    const opts = { ...options, type: Shape.CIRCLE };
    super(opts);
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

  computeAABB(out: AABB, position: Vec2, _angle: number): void {
    const r = this.radius;
    vec2.set(out.upperBound, r, r);
    vec2.set(out.lowerBound, -r, -r);
    if (position) {
      vec2.add(out.lowerBound, out.lowerBound, position);
      vec2.add(out.upperBound, out.upperBound, position);
    }
  }

  raycast(result: RaycastResult, ray: Ray, position: Vec2, _angle: number): void {
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
      vec2.lerp(intersectionPoint, from, to, delta);

      vec2.sub(normal, intersectionPoint, position);
      vec2.normalize(normal, normal);

      ray.reportIntersection(result, delta, normal, -1);
    } else {
      const sqrtDelta = Math.sqrt(delta);
      const inv2a = 1 / (2 * a);
      const d1 = (-b - sqrtDelta) * inv2a;
      const d2 = (-b + sqrtDelta) * inv2a;

      if (d1 >= 0 && d1 <= 1) {
        vec2.lerp(intersectionPoint, from, to, d1);

        vec2.sub(normal, intersectionPoint, position);
        vec2.normalize(normal, normal);

        ray.reportIntersection(result, d1, normal, -1);

        if (result.shouldStop(ray)) {
          return;
        }
      }

      if (d2 >= 0 && d2 <= 1) {
        vec2.lerp(intersectionPoint, from, to, d2);

        vec2.sub(normal, intersectionPoint, position);
        vec2.normalize(normal, normal);

        ray.reportIntersection(result, d2, normal, -1);
      }
    }
  }
}
