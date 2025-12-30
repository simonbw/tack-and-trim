import Shape, { ShapeOptions } from "./Shape";
import vec2, { Vec2 } from "../math/vec2";
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

  computeAABB(out: AABB, position: Vec2, _angle: number): void {
    vec2.copy(out.lowerBound, position);
    vec2.copy(out.upperBound, position);
  }
}
