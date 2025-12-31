import type Body from "../body/Body";
import type Shape from "../shapes/Shape";
import OverlapKeeperRecord from "./OverlapKeeperRecord";
import OverlapKeeperRecordPool from "./OverlapKeeperRecordPool";
import TupleDictionary from "./TupleDictionary";

/**
 * Keeps track of overlaps in the current state and the last step state.
 */
export default class OverlapKeeper {
  overlappingShapesLastState: TupleDictionary<OverlapKeeperRecord>;
  overlappingShapesCurrentState: TupleDictionary<OverlapKeeperRecord>;
  recordPool: OverlapKeeperRecordPool;
  tmpDict: TupleDictionary<OverlapKeeperRecord>;
  tmpArray1: OverlapKeeperRecord[];

  constructor() {
    this.overlappingShapesLastState = new TupleDictionary();
    this.overlappingShapesCurrentState = new TupleDictionary();
    this.recordPool = new OverlapKeeperRecordPool({ size: 16 });
    this.tmpDict = new TupleDictionary();
    this.tmpArray1 = [];
  }

  /**
   * Ticks one step forward in time. This will move the current overlap state
   * to the "old" overlap state, and create a new one as current.
   */
  tick(): void {
    const last = this.overlappingShapesLastState;
    const current = this.overlappingShapesCurrentState;

    // Save old objects into pool
    for (let i = last.keys.length - 1; i >= 0; i--) {
      const key = last.keys[i];
      const lastObject = last.getByKey(key);
      if (lastObject) {
        // The record is only used in the "last" dict, and will be removed.
        this.recordPool.release(lastObject);
      }
    }

    // Clear last object
    last.reset();

    // Transfer from new object to old
    last.copy(current);

    // Clear current object
    current.reset();
  }

  setOverlapping(bodyA: Body, shapeA: Shape, bodyB: Body, shapeB: Shape): void {
    const current = this.overlappingShapesCurrentState;

    // Store current contact state
    if (!current.get(shapeA.id, shapeB.id)) {
      const data = this.recordPool.get();
      data.set(bodyA, shapeA, bodyB, shapeB);
      current.set(shapeA.id, shapeB.id, data);
    }
  }

  getNewOverlaps(result?: OverlapKeeperRecord[]): OverlapKeeperRecord[] {
    const diff = this.getDiff(
      this.overlappingShapesLastState,
      this.overlappingShapesCurrentState
    );
    if (result) {
      result.length = 0;
      result.push(...diff);
      return result;
    }
    return diff;
  }

  getEndOverlaps(result?: OverlapKeeperRecord[]): OverlapKeeperRecord[] {
    const diff = this.getDiff(
      this.overlappingShapesCurrentState,
      this.overlappingShapesLastState
    );
    if (result) {
      result.length = 0;
      result.push(...diff);
      return result;
    }
    return diff;
  }

  /**
   * Checks if two bodies are currently overlapping.
   */
  bodiesAreOverlapping(bodyA: Body, bodyB: Body): boolean {
    const current = this.overlappingShapesCurrentState;
    for (let i = current.keys.length - 1; i >= 0; i--) {
      const key = current.keys[i];
      const data = current.data[key];
      if (
        (data.bodyA === bodyA && data.bodyB === bodyB) ||
        (data.bodyA === bodyB && data.bodyB === bodyA)
      ) {
        return true;
      }
    }
    return false;
  }

  getDiff(
    dictA: TupleDictionary<OverlapKeeperRecord>,
    dictB: TupleDictionary<OverlapKeeperRecord>
  ): OverlapKeeperRecord[] {
    const last = dictA;
    const current = dictB;
    const result: OverlapKeeperRecord[] = [];

    for (let i = current.keys.length - 1; i >= 0; i--) {
      const key = current.keys[i];
      const data = current.data[key];

      if (!data) {
        throw new Error("Key " + key + " had no data!");
      }

      const lastData = last.data[key];
      if (!lastData) {
        // Not overlapping in last state, but in current.
        result.push(data);
      }
    }

    return result;
  }

  isNewOverlap(shapeA: Shape, shapeB: Shape): boolean {
    const idA = shapeA.id;
    const idB = shapeB.id;
    const last = this.overlappingShapesLastState;
    const current = this.overlappingShapesCurrentState;
    // Not in last but in new
    return !last.get(idA, idB) && !!current.get(idA, idB);
  }

  getNewBodyOverlaps(result?: Body[]): Body[] {
    const overlaps = this.getNewOverlaps();
    return this.getBodyDiff(overlaps, result);
  }

  getEndBodyOverlaps(result?: Body[]): Body[] {
    const overlaps = this.getEndOverlaps();
    return this.getBodyDiff(overlaps, result);
  }

  getBodyDiff(overlaps: OverlapKeeperRecord[], result: Body[] = []): Body[] {
    const accumulator = this.tmpDict;

    for (let i = overlaps.length - 1; i >= 0; i--) {
      const data = overlaps[i];
      // Since we use body id's for the accumulator, these will be a subset of the original one
      accumulator.set(data.bodyA!.id, data.bodyB!.id, data);
    }

    for (let i = accumulator.keys.length - 1; i >= 0; i--) {
      const data = accumulator.getByKey(accumulator.keys[i]);
      if (data) {
        result.push(data.bodyA!, data.bodyB!);
      }
    }

    accumulator.reset();

    return result;
  }
}
