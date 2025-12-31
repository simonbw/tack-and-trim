import Shape, { ShapeOptions } from "./Shape";
import { V, V2d } from "../../Vector";
import AABB from "../collision/AABB";
import type RaycastResult from "../collision/RaycastResult";
import type Ray from "../collision/Ray";

export interface LineOptions extends ShapeOptions {
  length?: number;
}

const points = [V(), V()];
const raycast_normal = V();
const raycast_l0 = V();
const raycast_l1 = V();
const raycast_unit_y = V(0, 1);

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

  computeAABB(position: V2d, angle: number): AABB {
    const l2 = this.length / 2;
    points[0].set(-l2, 0);
    points[1].set(l2, 0);
    const out = new AABB();
    out.setFromPoints(points, position, angle, 0);
    return out;
  }

  raycast(result: RaycastResult, ray: Ray, position: V2d, angle: number): void {
    const from = ray.from;
    const to = ray.to;

    const l0 = raycast_l0;
    const l1 = raycast_l1;

    // get start and end of the line
    const halfLen = this.length / 2;
    l0.set(-halfLen, 0);
    l1.set(halfLen, 0);
    l0.itoGlobalFrame(position, angle);
    l1.itoGlobalFrame(position, angle);

    const fraction = V2d.lineSegmentsIntersectionFraction(l0, l1, from, to);
    if (fraction >= 0) {
      const normal = raycast_normal;
      normal.set(raycast_unit_y).irotate(angle);
      ray.reportIntersection(result, fraction, normal, -1);
    }
  }
}
