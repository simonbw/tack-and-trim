import { V, V2d } from "../../../Vector";
import type Body from "../../body/Body";
import type Shape from "../../shapes/Shape";

/**
 * Storage for Ray casting hit data.
 */
export default class RaycastResult {
  /** The normal of the hit, oriented in world space. */
  normal: V2d;

  /** The hit shape, or null. */
  shape: Shape | null = null;

  /** The hit body, or null. */
  body: Body | null = null;

  /** The index of the hit triangle, if the hit shape was indexable. Will be null if there was no hit. */
  faceIndex: number | null = null;

  /** Distance to the hit, as a fraction. 0 is at the "from" point, 1 is at the "to" point. Will be null if there was no hit yet. */
  fraction: number | null = null;

  /** If the ray should stop traversing. */
  isStopped: boolean = false;

  constructor() {
    this.normal = V();
  }

  /** Reset all result data. Must be done before re-using the result object. */
  reset(): void {
    this.normal.set(0, 0);
    this.shape = null;
    this.body = null;
    this.faceIndex = null;
    this.fraction = null;
    this.isStopped = false;
  }

  /**
   * Get the distance to the hit point.
   * Only valid to call after hasHit() returns true.
   */
  getHitDistance(ray: Ray): number {
    return ray.from.distanceTo(ray.to) * this.fraction!;
  }

  /**
   * Returns true if the ray hit something since the last reset().
   */
  hasHit(): boolean {
    return this.fraction !== null;
  }

  /**
   * Get world hit point.
   * Only valid to call after hasHit() returns true.
   */
  getHitPoint(ray: Ray): V2d {
    return V(ray.from).ilerp(ray.to, this.fraction!);
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
    return this.isStopped || (this.fraction !== null && ray.mode === Ray.ANY);
  }

  /**
   * @private
   */
  set(
    normal: V2d,
    shape: Shape,
    body: Body,
    fraction: number,
    faceIndex: number
  ): void {
    this.normal.set(normal);
    this.shape = shape;
    this.body = body;
    this.fraction = fraction;
    this.faceIndex = faceIndex;
  }
}

// Re-import Ray for the class reference used in shouldStop
// This creates a circular dependency but TypeScript handles it for runtime
import Ray from "./Ray";
