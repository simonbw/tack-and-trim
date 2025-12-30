import Shape, { ShapeOptions } from "./Shape";
import vec2, { Vec2 } from "../math/vec2";
import type AABB from "../collision/AABB";
import type RaycastResult from "../collision/RaycastResult";
import type Ray from "../collision/Ray";

export interface CapsuleOptions extends ShapeOptions {
  length?: number;
  radius?: number;
}

const r = vec2.create();
const intersectCapsule_hitPointWorld = vec2.create();
const intersectCapsule_normal = vec2.create();
const intersectCapsule_l0 = vec2.create();
const intersectCapsule_l1 = vec2.create();
const intersectCapsule_unit_y = vec2.fromValues(0, 1);

/**
 * Capsule shape class.
 */
export default class Capsule extends Shape {
  length: number;
  radius: number;

  constructor(options: CapsuleOptions = {}) {
    const opts = { ...options, type: Shape.CAPSULE };
    super(opts);
    this.length = options.length ?? 1;
    this.radius = options.radius ?? 1;
    this.updateBoundingRadius();
    this.updateArea();
  }

  computeMomentOfInertia(mass: number): number {
    // Approximate with rectangle
    const rad = this.radius;
    const w = this.length + rad;
    const h = rad * 2;
    return (mass * (h * h + w * w)) / 12;
  }

  updateBoundingRadius(): void {
    this.boundingRadius = this.radius + this.length / 2;
  }

  updateArea(): void {
    this.area =
      Math.PI * this.radius * this.radius + this.radius * 2 * this.length;
  }

  computeAABB(out: AABB, position: Vec2, angle: number): void {
    const radius = this.radius;

    vec2.set(r, this.length / 2, 0);
    if (angle !== 0) {
      vec2.rotate(r, r, angle);
    }

    vec2.set(
      out.upperBound,
      Math.max(r[0] + radius, -r[0] + radius),
      Math.max(r[1] + radius, -r[1] + radius)
    );
    vec2.set(
      out.lowerBound,
      Math.min(r[0] - radius, -r[0] - radius),
      Math.min(r[1] - radius, -r[1] - radius)
    );

    vec2.add(out.lowerBound, out.lowerBound, position);
    vec2.add(out.upperBound, out.upperBound, position);
  }

  raycast(result: RaycastResult, ray: Ray, position: Vec2, angle: number): void {
    const from = ray.from;
    const to = ray.to;

    const hitPointWorld = intersectCapsule_hitPointWorld;
    const normal = intersectCapsule_normal;
    const l0 = intersectCapsule_l0;
    const l1 = intersectCapsule_l1;

    // The sides
    const halfLen = this.length / 2;
    for (let i = 0; i < 2; i++) {
      const y = this.radius * (i * 2 - 1);
      vec2.set(l0, -halfLen, y);
      vec2.set(l1, halfLen, y);
      vec2.toGlobalFrame(l0, l0, position, angle);
      vec2.toGlobalFrame(l1, l1, position, angle);

      const delta = vec2.getLineSegmentsIntersectionFraction(from, to, l0, l1);
      if (delta >= 0) {
        vec2.rotate(normal, intersectCapsule_unit_y, angle);
        vec2.scale(normal, normal, i * 2 - 1);
        ray.reportIntersection(result, delta, normal, -1);
        if (result.shouldStop(ray)) {
          return;
        }
      }
    }

    // Circles
    const diagonalLengthSquared =
      Math.pow(this.radius, 2) + Math.pow(halfLen, 2);
    for (let i = 0; i < 2; i++) {
      vec2.set(l0, halfLen * (i * 2 - 1), 0);
      vec2.toGlobalFrame(l0, l0, position, angle);

      const a =
        Math.pow(to[0] - from[0], 2) + Math.pow(to[1] - from[1], 2);
      const b =
        2 *
        ((to[0] - from[0]) * (from[0] - l0[0]) +
          (to[1] - from[1]) * (from[1] - l0[1]));
      const c =
        Math.pow(from[0] - l0[0], 2) +
        Math.pow(from[1] - l0[1], 2) -
        Math.pow(this.radius, 2);
      const delta = Math.pow(b, 2) - 4 * a * c;

      if (delta < 0) {
        continue;
      } else if (delta === 0) {
        vec2.lerp(hitPointWorld, from, to, delta);

        if (vec2.squaredDistance(hitPointWorld, position) > diagonalLengthSquared) {
          vec2.sub(normal, hitPointWorld, l0);
          vec2.normalize(normal, normal);
          ray.reportIntersection(result, delta, normal, -1);
          if (result.shouldStop(ray)) {
            return;
          }
        }
      } else {
        const sqrtDelta = Math.sqrt(delta);
        const inv2a = 1 / (2 * a);
        const d1 = (-b - sqrtDelta) * inv2a;
        const d2 = (-b + sqrtDelta) * inv2a;

        if (d1 >= 0 && d1 <= 1) {
          vec2.lerp(hitPointWorld, from, to, d1);
          if (vec2.squaredDistance(hitPointWorld, position) > diagonalLengthSquared) {
            vec2.sub(normal, hitPointWorld, l0);
            vec2.normalize(normal, normal);
            ray.reportIntersection(result, d1, normal, -1);
            if (result.shouldStop(ray)) {
              return;
            }
          }
        }

        if (d2 >= 0 && d2 <= 1) {
          vec2.lerp(hitPointWorld, from, to, d2);
          if (vec2.squaredDistance(hitPointWorld, position) > diagonalLengthSquared) {
            vec2.sub(normal, hitPointWorld, l0);
            vec2.normalize(normal, normal);
            ray.reportIntersection(result, d2, normal, -1);
            if (result.shouldStop(ray)) {
              return;
            }
          }
        }
      }
    }
  }
}
