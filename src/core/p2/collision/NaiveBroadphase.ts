import Broadphase from "./Broadphase";
import AABB from "./AABB";
import type Body from "../objects/Body";
import type World from "../world/World";

/**
 * Naive broadphase implementation. Does N^2 tests.
 */
export default class NaiveBroadphase extends Broadphase {
  constructor() {
    super(Broadphase.NAIVE);
  }

  /**
   * Get the colliding pairs
   */
  getCollisionPairs(world: World): Body[] {
    const bodies = world.bodies;
    const result = this.result;

    result.length = 0;

    for (let i = 0, Ncolliding = bodies.length; i !== Ncolliding; i++) {
      const bi = bodies[i];

      for (let j = 0; j < i; j++) {
        const bj = bodies[j];

        if (Broadphase.canCollide(bi, bj) && this.boundingVolumeCheck(bi, bj)) {
          result.push(bi, bj);
        }
      }
    }

    return result;
  }

  /**
   * Returns all the bodies within an AABB.
   */
  aabbQuery(world: World, aabb: AABB, result: Body[] = []): Body[] {
    const bodies = world.bodies;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];

      if (b.aabbNeedsUpdate) {
        b.updateAABB();
      }

      if (b.aabb.overlaps(aabb)) {
        result.push(b);
      }
    }

    return result;
  }
}
