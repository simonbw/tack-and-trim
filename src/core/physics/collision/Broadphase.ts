import { V } from "../../Vector";
import type Body from "../body/Body";
import type World from "../world/World";
import type AABB from "./AABB";

const dist = V();

/**
 * Base class for broadphase implementations.
 */
export default abstract class Broadphase {
  static readonly AABB = 1;
  static readonly BOUNDING_CIRCLE = 2;

  result: Body[];
  world: World | null;

  constructor() {
    this.result = [];
    this.world = null;
  }

  /**
   * Set the world that we are searching for collision pairs in.
   */
  setWorld(world: World): void {
    this.world = world;
  }

  /**
   * Get all potential intersecting body pairs.
   */
  abstract getCollisionPairs(_world: World): Body[];

  /**
   * Check whether the AABBs of two bodies overlap.
   */
  boundingVolumeCheck(bodyA: Body, bodyB: Body): boolean {
    return bodyA.getAABB().overlaps(bodyB.getAABB());
  }

  /**
   * Returns all the bodies within an AABB.
   * @param shouldAddBodies If true, adds dynamic/kinematic bodies to hash before querying (SpatialHashingBroadphase only)
   */
  abstract aabbQuery(
    _world: World,
    _aabb: AABB,
    result?: Body[],
    _shouldAddBodies?: boolean
  ): Body[];

  /**
   * Check whether two bodies are allowed to collide at all.
   */
  static canCollide(bodyA: Body, bodyB: Body): boolean {
    // Body type constants
    const KINEMATIC = 4;
    const STATIC = 2;
    const SLEEPING = 2;

    // Cannot collide static bodies
    if (bodyA.type === STATIC && bodyB.type === STATIC) {
      return false;
    }

    // Cannot collide static vs kinematic bodies
    if (
      (bodyA.type === KINEMATIC && bodyB.type === STATIC) ||
      (bodyA.type === STATIC && bodyB.type === KINEMATIC)
    ) {
      return false;
    }

    // Cannot collide kinematic vs kinematic
    if (bodyA.type === KINEMATIC && bodyB.type === KINEMATIC) {
      return false;
    }

    // Cannot collide both sleeping bodies
    if (bodyA.sleepState === SLEEPING && bodyB.sleepState === SLEEPING) {
      return false;
    }

    // Cannot collide if one is static and the other is sleeping
    if (
      (bodyA.sleepState === SLEEPING && bodyB.type === STATIC) ||
      (bodyB.sleepState === SLEEPING && bodyA.type === STATIC)
    ) {
      return false;
    }

    return true;
  }
}
