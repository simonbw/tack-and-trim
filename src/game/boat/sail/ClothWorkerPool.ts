/**
 * Singleton entity that manages Web Workers for cloth sail simulation.
 * Spawns one worker per sail, communicating via SharedArrayBuffer.
 * Falls back to synchronous solving when SharedArrayBuffer is unavailable.
 */

import { BaseEntity } from "../../../core/entity/BaseEntity";
import { on } from "../../../core/entity/handler";
import { ClothSolver } from "./ClothSolver";
import { ClothSolverSync } from "./ClothSolverSync";
import {
  createSharedBuffer,
  getPositionsA,
  getPositionsB,
  type ClothInitMessage,
} from "./cloth-worker-protocol";
import { SailWorkerHandle } from "./SailWorkerHandle";

export interface ClothWorkerRegistration {
  solver: ClothSolver;
  vertexCount: number;
  indices: number[];
  tackIdx: number;
  clewIdx: number;
  headIdx: number;
}

export type SailHandle = SailWorkerHandle | ClothSolverSync;

export class ClothWorkerPool extends BaseEntity {
  id = "clothWorkerPool";
  persistenceLevel = 50;

  private workers: Map<SailHandle, Worker> = new Map();
  private useWorkers: boolean;

  constructor() {
    super();
    // Feature-detect SharedArrayBuffer
    this.useWorkers =
      typeof SharedArrayBuffer !== "undefined" &&
      typeof Atomics !== "undefined";
  }

  /**
   * Register a sail for off-thread solving.
   * Returns a handle for reading results and kicking solves.
   */
  register(config: ClothWorkerRegistration): SailHandle {
    if (!this.useWorkers) {
      return new ClothSolverSync(
        config.solver,
        config.indices,
        config.tackIdx,
        config.clewIdx,
        config.headIdx,
      );
    }

    const { solver, vertexCount, indices, tackIdx, clewIdx, headIdx } = config;

    // Create SharedArrayBuffer
    const sab = createSharedBuffer(vertexCount);

    // Spawn worker
    const worker = new Worker(new URL("./cloth-worker.ts", import.meta.url), {
      type: "module",
    });

    // Snapshot solver state for both handle init and worker init message
    const snapshot = solver.snapshotState();

    // Write initial positions to both SAB position buffers so reads are valid
    // immediately (before the worker has processed its init message)
    const posA = getPositionsA(sab, vertexCount);
    const posB = getPositionsB(sab, vertexCount);
    posA.set(snapshot.positions);
    posB.set(snapshot.positions);

    // Create handle — seed prevFrontPositions from solver so first-frame velocity is zero
    const handle = new SailWorkerHandle(sab, vertexCount, snapshot.positions);
    this.workers.set(handle, worker);

    // Send init message to worker
    const msg: ClothInitMessage = {
      type: "init",
      sab,
      vertexCount,
      indices,
      positions: snapshot.positions,
      prevPositions: snapshot.prevPositions,
      pinned: snapshot.pinned,
      pinTargets: snapshot.pinTargets,
      structA: snapshot.structA,
      structB: snapshot.structB,
      structRest: snapshot.structRest,
      shearA: snapshot.shearA,
      shearB: snapshot.shearB,
      shearRest: snapshot.shearRest,
      bendA: snapshot.bendA,
      bendB: snapshot.bendB,
      bendRest: snapshot.bendRest,
      damping: snapshot.damping,
      bendStiffness: snapshot.bendStiffness,
      constraintDamping: snapshot.constraintDamping,
      tackIdx,
      clewIdx,
      headIdx,
    };

    worker.postMessage(msg);

    return handle;
  }

  /** Unregister a sail and terminate its worker. */
  unregister(handle: SailHandle): void {
    const worker = this.workers.get(handle);
    if (worker) {
      worker.postMessage({ type: "destroy" });
      worker.terminate();
      this.workers.delete(handle);
    }
  }

  @on("destroy")
  onDestroy() {
    for (const [handle, worker] of this.workers) {
      worker.postMessage({ type: "destroy" });
      worker.terminate();
    }
    this.workers.clear();
  }
}
