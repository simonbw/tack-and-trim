import type Body from "../../body/Body";
import KinematicBody from "../../body/KinematicBody";
import StaticBody from "../../body/StaticBody";
import type World from "../../world/World";
import type AABB from "../AABB";

/**
 * Base class for broadphase implementations.
 */
export default abstract class Broadphase {
  static readonly AABB = 1;
  static readonly BOUNDING_CIRCLE = 2;

  result: Body[];
  world: World | null;

  constructor(world?: World) {
    this.result = [];
    this.world = world ?? null;
  }

  /**
   * Get all potential intersecting body pairs.
   */
  abstract getCollisionPairs(_world: World): Body[];

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
   * Set the world that we are searching for collision pairs in.
   */
  setWorld(world: World): void {
    this.world = world;
  }

  /**
   * Check whether the AABBs of two bodies overlap.
   */
  boundingVolumeCheck(bodyA: Body, bodyB: Body): boolean {
    return bodyA.getAABB().overlaps(bodyB.getAABB());
  }

  /**
   * Check whether two bodies are allowed to collide at all.
   */
  canCollide(bodyA: Body, bodyB: Body): boolean {
    const SLEEPING = 2; // Body.SLEEPING

    // Cannot collide static bodies
    if (bodyA instanceof StaticBody && bodyB instanceof StaticBody) {
      return false;
    }

    // Cannot collide static vs kinematic bodies
    if (
      (bodyA instanceof KinematicBody && bodyB instanceof StaticBody) ||
      (bodyA instanceof StaticBody && bodyB instanceof KinematicBody)
    ) {
      return false;
    }

    // Cannot collide kinematic vs kinematic
    if (bodyA instanceof KinematicBody && bodyB instanceof KinematicBody) {
      return false;
    }

    // Cannot collide both sleeping bodies
    if (bodyA.sleepState === SLEEPING && bodyB.sleepState === SLEEPING) {
      return false;
    }

    // Cannot collide if one is static and the other is sleeping
    if (
      (bodyA.sleepState === SLEEPING && bodyB instanceof StaticBody) ||
      (bodyB.sleepState === SLEEPING && bodyA instanceof StaticBody)
    ) {
      return false;
    }

    return true;
  }
}
