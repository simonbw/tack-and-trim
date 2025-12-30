import Shape, { ShapeOptions } from "./Shape";
import vec2, { Vec2 } from "../math/vec2";
import type AABB from "../collision/AABB";
import type RaycastResult from "../collision/RaycastResult";
import type Ray from "../collision/Ray";

export interface LineOptions extends ShapeOptions {
  length?: number;
}

const points = [vec2.create(), vec2.create()];
const raycast_normal = vec2.create();
const raycast_l0 = vec2.create();
const raycast_l1 = vec2.create();
const raycast_unit_y = vec2.fromValues(0, 1);

/**
 * Line shape class. The line shape is along the x direction, and stretches from [-length/2, 0] to [length/2,0].
 */
export default class Line extends Shape {
  length: number;

  constructor(options: LineOptions = {}) {
    const opts = { ...options, type: Shape.LINE };
    super(opts);
    this.length = options.length ?? 1;
    this.updateBoundingRadius();
    this.updateArea();
  }

  computeMomentOfInertia(mass: number): number {
    return (mass * Math.pow(this.length, 2)) / 12;
  }

  updateBoundingRadius(): void {
    this.boundingRadius = this.length / 2;
  }

  computeAABB(out: AABB, position: Vec2, angle: number): void {
    const l2 = this.length / 2;
    vec2.set(points[0], -l2, 0);
    vec2.set(points[1], l2, 0);
    out.setFromPoints(points, position, angle, 0);
  }

  raycast(result: RaycastResult, ray: Ray, position: Vec2, angle: number): void {
    const from = ray.from;
    const to = ray.to;

    const l0 = raycast_l0;
    const l1 = raycast_l1;

    // get start and end of the line
    const halfLen = this.length / 2;
    vec2.set(l0, -halfLen, 0);
    vec2.set(l1, halfLen, 0);
    vec2.toGlobalFrame(l0, l0, position, angle);
    vec2.toGlobalFrame(l1, l1, position, angle);

    const fraction = vec2.getLineSegmentsIntersectionFraction(l0, l1, from, to);
    if (fraction >= 0) {
      const normal = raycast_normal;
      vec2.rotate(normal, raycast_unit_y, angle);
      ray.reportIntersection(result, fraction, normal, -1);
    }
  }
}
