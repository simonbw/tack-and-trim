import { V, V2d } from "../../Vector";
import Shape from "./Shape";
import Convex, { ConvexOptions } from "./Convex";
import type AABB from "../collision/AABB";

export interface BoxOptions extends ConvexOptions {
  width?: number;
  height?: number;
}

/**
 * Box shape class.
 */
export default class Box extends Convex {
  width: number;
  height: number;

  constructor(options: BoxOptions = {}) {
    const width = options.width ?? 1;
    const height = options.height ?? 1;

    const verts = [
      V(-width / 2, -height / 2),
      V(width / 2, -height / 2),
      V(width / 2, height / 2),
      V(-width / 2, height / 2),
    ];
    const axes = [V(1, 0), V(0, 1)];

    const opts = {
      ...options,
      vertices: verts,
      axes: axes,
      type: Shape.BOX,
    };
    super(opts);

    this.width = width;
    this.height = height;

    // Re-calculate with correct width/height (Convex uses vertex-based calculation)
    this.updateBoundingRadius();
    this.updateArea();
  }

  computeMomentOfInertia(mass: number): number {
    const w = this.width;
    const h = this.height;
    return (mass * (h * h + w * w)) / 12;
  }

  updateBoundingRadius(): void {
    const w = this.width;
    const h = this.height;
    this.boundingRadius = Math.sqrt(w * w + h * h) / 2;
  }

  computeAABB(out: AABB, position: V2d, angle: number): void {
    out.setFromPoints(this.vertices, position, angle, 0);
  }

  updateArea(): void {
    this.area = this.width * this.height;
  }
}
