import { V2d } from "../../Vector";
import type Body from "../body/Body";
import type World from "../world/World";
import type AABB from "./AABB";

const dist = new V2d(0, 0);

/**
 * Base class for broadphase implementations.
 */
export default class Broadphase {
  static readonly AABB = 1;
  static readonly BOUNDING_CIRCLE = 2;
  static readonly NAIVE = 1;
  static readonly SAP = 2;

  type: number;
  result: Body[];
  world: World | null;
  boundingVolumeType: number;

  constructor(type?: number) {
    this.type = type ?? 0;
    this.result = [];
    this.world = null;
    this.boundingVolumeType = Broadphase.AABB;
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
  getCollisionPairs(_world: World): Body[] {
    return [];
  }

  /**
   * Check whether the bounding radius of two bodies overlap.
   */
  static boundingRadiusCheck(bodyA: Body, bodyB: Body): boolean {
    dist.set(bodyA.position).isub(bodyB.position);
    const d2 = dist.squaredMagnitude;
    const r = bodyA.boundingRadius + bodyB.boundingRadius;
    return d2 <= r * r;
  }

  /**
   * Check whether the AABBs of two bodies overlap.
   */
  static aabbCheck(bodyA: Body, bodyB: Body): boolean {
    return bodyA.getAABB().overlaps(bodyB.getAABB());
  }

  /**
   * Check whether the bounding volumes of two bodies overlap.
   */
  boundingVolumeCheck(bodyA: Body, bodyB: Body): boolean {
    let result: boolean;

    switch (this.boundingVolumeType) {
      case Broadphase.BOUNDING_CIRCLE:
        result = Broadphase.boundingRadiusCheck(bodyA, bodyB);
        break;
      case Broadphase.AABB:
        result = Broadphase.aabbCheck(bodyA, bodyB);
        break;
      default:
        throw new Error(
          "Bounding volume type not recognized: " + this.boundingVolumeType
        );
    }
    return result;
  }

  /**
   * Returns all the bodies within an AABB.
   * @param shouldAddBodies If true, adds dynamic/kinematic bodies to hash before querying (SpatialHashingBroadphase only)
   */
  aabbQuery(
    _world: World,
    _aabb: AABB,
    result: Body[] = [],
    _shouldAddBodies: boolean = true
  ): Body[] {
    return result;
  }

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
