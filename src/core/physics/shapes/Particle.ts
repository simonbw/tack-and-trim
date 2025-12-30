import Shape, { ShapeOptions } from "./Shape";
import { V2d } from "../../Vector";
import type AABB from "../collision/AABB";

/**
 * Particle shape class.
 */
export default class Particle extends Shape {
  constructor(options: ShapeOptions = {}) {
    const opts = { ...options, type: Shape.PARTICLE };
    super(opts);
    this.updateBoundingRadius();
    this.updateArea();
  }

  computeMomentOfInertia(_mass: number): number {
    return 0; // Can't rotate a particle
  }

  updateBoundingRadius(): void {
    this.boundingRadius = 0;
  }

  computeAABB(out: AABB, position: V2d, _angle: number): void {
    out.lowerBound.set(position);
    out.upperBound.set(position);
  }
}
