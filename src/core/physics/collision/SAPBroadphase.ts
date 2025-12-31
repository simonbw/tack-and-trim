import type Body from "../body/Body";
import type World from "../world/World";
import AABB from "./AABB";
import Broadphase from "./Broadphase";

/**
 * Sweep and prune broadphase along one axis.
 */
export default class SAPBroadphase extends Broadphase {
  /**
   * List of bodies currently in the broadphase.
   */
  axisList: Body[] = [];

  /**
   * The axis to sort along. 0 means x-axis and 1 y-axis.
   */
  axisIndex: number = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _addBodyHandler: (e: any) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _removeBodyHandler: (e: any) => void;

  constructor(type?: number) {
    super(type ?? Broadphase.SAP);

    this._addBodyHandler = (e: { body: Body }) => {
      this.axisList.push(e.body);
    };

    this._removeBodyHandler = (e: { body: Body }) => {
      const idx = this.axisList.indexOf(e.body);
      if (idx !== -1) {
        this.axisList.splice(idx, 1);
      }
    };
  }

  /**
   * Change the world
   */
  setWorld(world: World): void {
    // Clear the old axis array
    this.axisList.length = 0;

    // Add all bodies from the new world
    this.axisList.push(...world.bodies);

    // Remove old handlers, if any
    world
      .off("addBody", this._addBodyHandler)
      .off("removeBody", this._removeBodyHandler);

    // Add handlers to update the list of bodies.
    world
      .on("addBody", this._addBodyHandler)
      .on("removeBody", this._removeBodyHandler);

    this.world = world;
  }

  /**
   * Sorts bodies along an axis.
   */
  static sortAxisList(a: Body[], axisIndex: number): Body[] {
    for (let i = 1, l = a.length; i < l; i++) {
      const v = a[i];
      let j: number;
      for (j = i - 1; j >= 0; j--) {
        if (a[j].aabb.lowerBound[axisIndex] <= v.aabb.lowerBound[axisIndex]) {
          break;
        }
        a[j + 1] = a[j];
      }
      a[j + 1] = v;
    }
    return a;
  }

  sortList(): void {
    const bodies = this.axisList;
    const axisIndex = this.axisIndex;

    // Sort the lists
    SAPBroadphase.sortAxisList(bodies, axisIndex);
  }

  /**
   * Get the colliding pairs
   */
  getCollisionPairs(world: World): Body[] {
    const bodies = this.axisList;
    const result = this.result;
    const axisIndex = this.axisIndex;

    result.length = 0;

    // Update all AABBs if needed
    let l = bodies.length;
    while (l--) {
      const b = bodies[l];
      if (b.aabbNeedsUpdate) {
        b.updateAABB();
      }
    }

    // Sort the lists
    this.sortList();

    // Look through the X list
    for (let i = 0, N = bodies.length; i !== N; i++) {
      const bi = bodies[i];

      for (let j = i + 1; j < N; j++) {
        const bj = bodies[j];

        // Bounds overlap?
        const overlaps =
          bj.aabb.lowerBound[axisIndex] <= bi.aabb.upperBound[axisIndex];
        if (!overlaps) {
          break;
        }

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
  aabbQuery(
    _world: World,
    aabb: AABB,
    result: Body[] = [],
    _shouldAddBodies: boolean = true
  ): Body[] {
    this.sortList();

    const axisIndex = this.axisIndex;
    const axisList = this.axisList;

    for (let i = 0; i < axisList.length; i++) {
      const b = axisList[i];

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
