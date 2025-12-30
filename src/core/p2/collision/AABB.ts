import vec2, { Vec2 } from "../math/vec2";
import type Ray from "./Ray";

export interface AABBOptions {
  upperBound?: Vec2;
  lowerBound?: Vec2;
}

const tmp = vec2.create();

/**
 * Axis aligned bounding box class.
 */
export default class AABB {
  lowerBound: Vec2;
  upperBound: Vec2;

  constructor(options: AABBOptions = {}) {
    this.lowerBound = vec2.create();
    if (options.lowerBound) {
      vec2.copy(this.lowerBound, options.lowerBound);
    }

    this.upperBound = vec2.create();
    if (options.upperBound) {
      vec2.copy(this.upperBound, options.upperBound);
    }
  }

  /**
   * Set the AABB bounds from a set of points, transformed by the given position and angle.
   */
  setFromPoints(
    points: Vec2[],
    position?: Vec2,
    angle: number = 0,
    skinSize: number = 0
  ): void {
    const l = this.lowerBound;
    const u = this.upperBound;

    // Set to the first point
    if (angle !== 0) {
      vec2.rotate(l, points[0], angle);
    } else {
      vec2.copy(l, points[0]);
    }
    vec2.copy(u, l);

    // Compute cosines and sines just once
    const cosAngle = Math.cos(angle);
    const sinAngle = Math.sin(angle);

    for (let i = 1; i < points.length; i++) {
      let p = points[i];

      if (angle !== 0) {
        const x = p[0];
        const y = p[1];
        tmp[0] = cosAngle * x - sinAngle * y;
        tmp[1] = sinAngle * x + cosAngle * y;
        p = tmp;
      }

      for (let j = 0; j < 2; j++) {
        if (p[j] > u[j]) {
          u[j] = p[j];
        }
        if (p[j] < l[j]) {
          l[j] = p[j];
        }
      }
    }

    // Add offset
    if (position) {
      vec2.add(this.lowerBound, this.lowerBound, position);
      vec2.add(this.upperBound, this.upperBound, position);
    }

    if (skinSize) {
      this.lowerBound[0] -= skinSize;
      this.lowerBound[1] -= skinSize;
      this.upperBound[0] += skinSize;
      this.upperBound[1] += skinSize;
    }
  }

  /**
   * Copy bounds from an AABB to this AABB
   */
  copy(aabb: AABB): void {
    vec2.copy(this.lowerBound, aabb.lowerBound);
    vec2.copy(this.upperBound, aabb.upperBound);
  }

  /**
   * Extend this AABB so that it covers the given AABB too.
   */
  extend(aabb: AABB): void {
    let i = 2;
    while (i--) {
      // Extend lower bound
      const l = aabb.lowerBound[i];
      if (this.lowerBound[i] > l) {
        this.lowerBound[i] = l;
      }

      // Upper
      const u = aabb.upperBound[i];
      if (this.upperBound[i] < u) {
        this.upperBound[i] = u;
      }
    }
  }

  /**
   * Returns true if the given AABB overlaps this AABB.
   */
  overlaps(aabb: AABB): boolean {
    const l1 = this.lowerBound;
    const u1 = this.upperBound;
    const l2 = aabb.lowerBound;
    const u2 = aabb.upperBound;

    return (
      ((l2[0] <= u1[0] && u1[0] <= u2[0]) ||
        (l1[0] <= u2[0] && u2[0] <= u1[0])) &&
      ((l2[1] <= u1[1] && u1[1] <= u2[1]) || (l1[1] <= u2[1] && u2[1] <= u1[1]))
    );
  }

  /**
   * Check if this AABB contains the given point
   */
  containsPoint(point: Vec2): boolean {
    const l = this.lowerBound;
    const u = this.upperBound;
    return (
      l[0] <= point[0] &&
      point[0] <= u[0] &&
      l[1] <= point[1] &&
      point[1] <= u[1]
    );
  }

  /**
   * Check if the AABB is hit by a ray.
   * @returns -1 if no hit, a number between 0 and 1 if hit.
   */
  overlapsRay(ray: Ray): number {
    // ray.direction is unit direction vector of ray
    const dirFracX = 1 / ray.direction[0];
    const dirFracY = 1 / ray.direction[1];

    // this.lowerBound is the corner of AABB with minimal coordinates - left bottom, rt is maximal corner
    const t1 = (this.lowerBound[0] - ray.from[0]) * dirFracX;
    const t2 = (this.upperBound[0] - ray.from[0]) * dirFracX;
    const t3 = (this.lowerBound[1] - ray.from[1]) * dirFracY;
    const t4 = (this.upperBound[1] - ray.from[1]) * dirFracY;

    const tmin = Math.max(Math.min(t1, t2), Math.min(t3, t4));
    const tmax = Math.min(Math.max(t1, t2), Math.max(t3, t4));

    // if tmax < 0, ray (line) is intersecting AABB, but whole AABB is behind us
    if (tmax < 0) {
      return -1;
    }

    // if tmin > tmax, ray doesn't intersect AABB
    if (tmin > tmax) {
      return -1;
    }

    return tmin;
  }
}
