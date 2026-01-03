import type Body from "../../body/Body";
import type World from "../../world/World";
import type AABB from "../AABB";

/** Base class for broadphase implementations. */
export default abstract class Broadphase {
  result: [Body, Body][];
  world: World | null;

  constructor(world?: World) {
    this.result = [];
    this.world = world ?? null;
  }

  /** Get all potential intersecting body pairs. */
  abstract getCollisionPairs(_world: World): [Body, Body][];

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

  /** Set the world that we are searching for collision pairs in. */
  setWorld(world: World): void {
    this.world = world;
  }

  /** Check whether the AABBs of two bodies overlap. */
  boundingVolumeCheck(bodyA: Body, bodyB: Body): boolean {
    return bodyA.getAABB().overlaps(bodyB.getAABB());
  }
}
