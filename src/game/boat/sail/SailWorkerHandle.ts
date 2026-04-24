/**
 * Main-thread handle for a cloth solver running in a Web Worker.
 * Wraps a SharedArrayBuffer and implements ClothPositionReader
 * so ClothRenderer can read positions directly.
 */

import type { ClothPositionReader } from "./ClothRenderer";
import {
  CLOTH_IDLE,
  CLOTH_SOLVING,
  CLOTH_DONE,
  getControlView,
  getInputView,
  getPositionsA,
  getPositionsB,
  getReactionForces,
  INPUT_DT,
  INPUT_SUBSTEPS,
  INPUT_ITERATIONS,
  INPUT_CONSTRAINT_DAMPING,
  INPUT_CLOTH_MASS,
  INPUT_HOIST_AMOUNT,
  INPUT_WIND_X,
  INPUT_WIND_Y,
  INPUT_LIFT_SCALE,
  INPUT_DRAG_SCALE,
  INPUT_TACK_X,
  INPUT_TACK_Y,
  INPUT_TACK_Z,
  INPUT_CLEW_X,
  INPUT_CLEW_Y,
  INPUT_CLEW_Z,
  INPUT_HEAD_X,
  INPUT_HEAD_Y,
  INPUT_HEAD_Z,
  INPUT_CLEW_PINNED,
  REACTION_TACK_X,
  REACTION_TACK_Y,
  REACTION_HEAD_X,
  REACTION_HEAD_Y,
  REACTION_CLEW_X,
  REACTION_CLEW_Y,
  REACTION_COUNT,
} from "./cloth-worker-protocol";

export interface SailSolveInputs {
  dt: number;
  substeps: number;
  iterations: number;
  constraintDamping: number;
  clothMass: number;
  hoistAmount: number;
  windX: number;
  windY: number;
  liftScale: number;
  dragScale: number;
  tackX: number;
  tackY: number;
  tackZ: number;
  clewX: number;
  clewY: number;
  clewZ: number;
  headX: number;
  headY: number;
  headZ: number;
  clewPinned: boolean;
}

export class SailWorkerHandle implements ClothPositionReader {
  private readonly control: Int32Array;
  private readonly input: Float64Array;
  private readonly posA: Float64Array;
  private readonly posB: Float64Array;
  private readonly reactionBuf: Float64Array;
  private readonly vertexCount: number;

  /** Main-thread copy of previous front-buffer positions for velocity estimation. */
  private readonly prevFrontPositions: Float64Array;

  /** Which buffer is currently "front" (readable by renderer). */
  private frontIsA = true;

  constructor(
    sab: SharedArrayBuffer,
    vertexCount: number,
    initialPositions?: Float64Array,
  ) {
    this.vertexCount = vertexCount;
    this.control = getControlView(sab);
    this.input = getInputView(sab);
    this.posA = getPositionsA(sab, vertexCount);
    this.posB = getPositionsB(sab, vertexCount);
    this.reactionBuf = getReactionForces(sab, vertexCount);
    this.prevFrontPositions = new Float64Array(vertexCount * 3);
    if (initialPositions) {
      this.prevFrontPositions.set(initialPositions);
    }
  }

  /** Check if the worker has finished a solve since last ack. */
  hasNewResults(): boolean {
    return Atomics.load(this.control, 0) === CLOTH_DONE;
  }

  /**
   * Block (asynchronously) until the worker finishes the in-flight solve.
   * No-op if no solve is in flight (state is IDLE or already DONE), so the
   * very first tick — before any kick — returns immediately.
   *
   * Mirrors `QueryWorkerPool.awaitFrameComplete`: `Atomics.wait` is illegal
   * on the main thread, so we use `Atomics.waitAsync` and await the promise.
   * This guarantees the cloth pipeline runs at exactly one-tick lag — kick
   * after physics in tick N, read at the start of tick N+1 — instead of
   * silently dropping inputs or reaction forces when the worker can't keep
   * up with the tick rate.
   */
  async awaitResults(): Promise<void> {
    const { async, value } = Atomics.waitAsync(
      this.control,
      0,
      CLOTH_SOLVING,
      2000,
    );
    if (async) {
      const result = await value;
      if (result === "timed-out") {
        console.warn(
          "[cloth] worker did not complete within 2s; proceeding without results this tick",
        );
      }
    }
  }

  /** Read accumulated reaction forces. Returns [tackRx, tackRy, headRx, headRy, clewRx, clewRy]. */
  readReactionForces(): Float64Array {
    return this.reactionBuf;
  }

  /** Acknowledge results — copies current front to prev, swaps front/back, resets state to IDLE. */
  ackResults(): void {
    // Save current front positions as "previous" for velocity estimation
    const front = this.getFrontBuffer();
    this.prevFrontPositions.set(front);

    // The worker flipped the swap flag, so our front/back swap
    const swapFlag = Atomics.load(this.control, 1);
    this.frontIsA = swapFlag !== 0; // worker wrote to back then flipped; new front is the opposite

    // Reset state to IDLE so the worker can wait again
    Atomics.store(this.control, 0, CLOTH_IDLE);
  }

  /** Write inputs to SAB and kick off the next solve. */
  writeInputsAndKick(inputs: SailSolveInputs): void {
    this.input[INPUT_DT] = inputs.dt;
    this.input[INPUT_SUBSTEPS] = inputs.substeps;
    this.input[INPUT_ITERATIONS] = inputs.iterations;
    this.input[INPUT_CONSTRAINT_DAMPING] = inputs.constraintDamping;
    this.input[INPUT_CLOTH_MASS] = inputs.clothMass;
    this.input[INPUT_HOIST_AMOUNT] = inputs.hoistAmount;
    this.input[INPUT_WIND_X] = inputs.windX;
    this.input[INPUT_WIND_Y] = inputs.windY;
    this.input[INPUT_LIFT_SCALE] = inputs.liftScale;
    this.input[INPUT_DRAG_SCALE] = inputs.dragScale;
    this.input[INPUT_TACK_X] = inputs.tackX;
    this.input[INPUT_TACK_Y] = inputs.tackY;
    this.input[INPUT_TACK_Z] = inputs.tackZ;
    this.input[INPUT_CLEW_X] = inputs.clewX;
    this.input[INPUT_CLEW_Y] = inputs.clewY;
    this.input[INPUT_CLEW_Z] = inputs.clewZ;
    this.input[INPUT_HEAD_X] = inputs.headX;
    this.input[INPUT_HEAD_Y] = inputs.headY;
    this.input[INPUT_HEAD_Z] = inputs.headZ;
    this.input[INPUT_CLEW_PINNED] = inputs.clewPinned ? 1 : 0;

    // Signal the worker to start solving
    Atomics.store(this.control, 0, CLOTH_SOLVING);
    Atomics.notify(this.control, 0);
  }

  // ---- ClothPositionReader interface ----

  getPositionX(i: number): number {
    return this.getFrontBuffer()[i * 3];
  }

  getPositionY(i: number): number {
    return this.getFrontBuffer()[i * 3 + 1];
  }

  getZ(i: number): number {
    return this.getFrontBuffer()[i * 3 + 2];
  }

  // ---- Previous positions for TellTail velocity ----

  getPrevPositionX(i: number): number {
    return this.prevFrontPositions[i * 3];
  }

  getPrevPositionY(i: number): number {
    return this.prevFrontPositions[i * 3 + 1];
  }

  private getFrontBuffer(): Float64Array {
    return this.frontIsA ? this.posA : this.posB;
  }
}
