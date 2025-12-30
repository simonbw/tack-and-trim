import vec2, { Vec2 } from "../math/vec2";
import type Shape from "../shapes/Shape";
import type Body from "../objects/Body";

/**
 * Storage for Ray casting hit data.
 */
export default class RaycastResult {
  /**
   * The normal of the hit, oriented in world space.
   */
  normal: Vec2;

  /**
   * The hit shape, or null.
   */
  shape: Shape | null = null;

  /**
   * The hit body, or null.
   */
  body: Body | null = null;

  /**
   * The index of the hit triangle, if the hit shape was indexable.
   */
  faceIndex: number = -1;

  /**
   * Distance to the hit, as a fraction. 0 is at the "from" point, 1 is at the "to" point.
   * Will be set to -1 if there was no hit yet.
   */
  fraction: number = -1;

  /**
   * If the ray should stop traversing.
   */
  isStopped: boolean = false;

  constructor() {
    this.normal = vec2.create();
  }

  /**
   * Reset all result data. Must be done before re-using the result object.
   */
  reset(): void {
    vec2.set(this.normal, 0, 0);
    this.shape = null;
    this.body = null;
    this.faceIndex = -1;
    this.fraction = -1;
    this.isStopped = false;
  }

  /**
   * Get the distance to the hit point.
   */
  getHitDistance(ray: Ray): number {
    return vec2.distance(ray.from, ray.to) * this.fraction;
  }

  /**
   * Returns true if the ray hit something since the last reset().
   */
  hasHit(): boolean {
    return this.fraction !== -1;
  }

  /**
   * Get world hit point.
   */
  getHitPoint(out: Vec2, ray: Ray): void {
    vec2.lerp(out, ray.from, ray.to, this.fraction);
  }

  /**
   * Can be called while iterating over hits to stop searching for hit points.
   */
  stop(): void {
    this.isStopped = true;
  }

  /**
   * @private
   */
  shouldStop(ray: Ray): boolean {
    return this.isStopped || (this.fraction !== -1 && ray.mode === Ray.ANY);
  }

  /**
   * @private
   */
  set(
    normal: Vec2,
    shape: Shape,
    body: Body,
    fraction: number,
    faceIndex: number
  ): void {
    vec2.copy(this.normal, normal);
    this.shape = shape;
    this.body = body;
    this.fraction = fraction;
    this.faceIndex = faceIndex;
  }
}

// Re-import Ray for the class reference used in shouldStop
// This creates a circular dependency but TypeScript handles it for runtime
import Ray from "./Ray";
