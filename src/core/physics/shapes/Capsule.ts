import Shape, { ShapeOptions } from "./Shape";
import { V2d } from "../../Vector";
import type AABB from "../collision/AABB";
import type RaycastResult from "../collision/RaycastResult";
import type Ray from "../collision/Ray";

export interface CapsuleOptions extends ShapeOptions {
  length?: number;
  radius?: number;
}

const r = new V2d(0, 0);
const intersectCapsule_hitPointWorld = new V2d(0, 0);
const intersectCapsule_normal = new V2d(0, 0);
const intersectCapsule_l0 = new V2d(0, 0);
const intersectCapsule_l1 = new V2d(0, 0);
const intersectCapsule_unit_y = new V2d(0, 1);

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

  computeAABB(out: AABB, position: V2d, angle: number): void {
    const radius = this.radius;

    r.set(this.length / 2, 0);
    if (angle !== 0) {
      r.irotate(angle);
    }

    out.upperBound.set(
      Math.max(r[0] + radius, -r[0] + radius),
      Math.max(r[1] + radius, -r[1] + radius)
    );
    out.lowerBound.set(
      Math.min(r[0] - radius, -r[0] - radius),
      Math.min(r[1] - radius, -r[1] - radius)
    );

    out.lowerBound.iadd(position);
    out.upperBound.iadd(position);
  }

  raycast(result: RaycastResult, ray: Ray, position: V2d, angle: number): void {
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
      l0.set(-halfLen, y);
      l1.set(halfLen, y);
      l0.itoGlobalFrame(position, angle);
      l1.itoGlobalFrame(position, angle);

      const delta = V2d.lineSegmentsIntersectionFraction(from, to, l0, l1);
      if (delta >= 0) {
        normal.set(intersectCapsule_unit_y).irotate(angle);
        normal.imul(i * 2 - 1);
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
      l0.set(halfLen * (i * 2 - 1), 0);
      l0.itoGlobalFrame(position, angle);

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
        hitPointWorld.set(from).ilerp(to, delta);

        if (hitPointWorld.squaredDistanceTo(position) > diagonalLengthSquared) {
          normal.set(hitPointWorld).isub(l0);
          normal.inormalize();
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
          hitPointWorld.set(from).ilerp(to, d1);
          if (hitPointWorld.squaredDistanceTo(position) > diagonalLengthSquared) {
            normal.set(hitPointWorld).isub(l0);
            normal.inormalize();
            ray.reportIntersection(result, d1, normal, -1);
            if (result.shouldStop(ray)) {
              return;
            }
          }
        }

        if (d2 >= 0 && d2 <= 1) {
          hitPointWorld.set(from).ilerp(to, d2);
          if (hitPointWorld.squaredDistanceTo(position) > diagonalLengthSquared) {
            normal.set(hitPointWorld).isub(l0);
            normal.inormalize();
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
