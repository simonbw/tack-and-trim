import {
  CTRL_DESCRIPTORS_BASE,
  CTRL_DESCRIPTOR_POINT_COUNT,
  CTRL_DESCRIPTOR_RESERVED,
  CTRL_DESCRIPTOR_STRIDE,
  CTRL_DESCRIPTOR_STRIDE_FIELD,
  CTRL_DESCRIPTOR_TYPE_ID,
  CTRL_GENERATION,
  CTRL_NUM_TYPES,
  CTRL_REMAINING,
  CTRL_RESERVED,
  CTRL_TOTAL_INTS,
  MAX_DESCRIPTORS,
  PARAMS_FLOATS_PER_CHANNEL,
  QUERY_TYPE_TERRAIN,
  QUERY_TYPE_WATER,
  QUERY_TYPE_WIND,
  type QueryTypeId,
  type QueryWorkerChannel,
  type QueryWorkerInitMessage,
  STRIDE_PER_POINT,
} from "./query-worker-protocol";

/**
 * Per-query-type SAB pair (points in, results out) held on the main
 * thread. The `points` view is what callers write into before submitting
 * a frame. The `results` view is what callers read after the frame
 * completes.
 */
interface PoolChannel {
  pointsSab: SharedArrayBuffer;
  resultsSab: SharedArrayBuffer;
  paramsSab: SharedArrayBuffer;
  frameStateSab: SharedArrayBuffer | null;
  points: Float32Array;
  results: Float32Array;
  params: Float32Array;
  frameState: Float32Array | null;
  worldState: readonly Uint32Array[];
  maxPoints: number;
  resultStride: number;
}

export interface QueryWorkerPoolOptions {
  workerCount: number;
  /**
   * Per-query-type buffer sizing. Determines the SAB allocations passed
   * to workers on init.
   *
   * `worldState` — optional immutable data blob (packed terrain, packed
   * wind mesh, packed wave mesh). Copied into each worker on init.
   *
   * `frameStateSab` — optional SharedArrayBuffer for frame-mutable state
   * (water modifiers). Main thread writes each frame, worker reads live.
   */
  terrain: {
    maxPoints: number;
    resultStride: number;
    worldState?: readonly Uint32Array[];
    frameStateSab?: SharedArrayBuffer | null;
  };
  water: {
    maxPoints: number;
    resultStride: number;
    worldState?: readonly Uint32Array[];
    frameStateSab?: SharedArrayBuffer | null;
  };
  wind: {
    maxPoints: number;
    resultStride: number;
    worldState?: readonly Uint32Array[];
    frameStateSab?: SharedArrayBuffer | null;
  };
}

/**
 * Manages a pool of web workers that share SABs with the main thread.
 *
 * The pool is query-type-agnostic: it holds one channel (points + results
 * SAB pair) per query type, and a single control SAB that drives a
 * generation-counter handshake.
 *
 * Lifecycle:
 * 1. `new QueryWorkerPool({...})` spawns workers and ships init messages.
 * 2. Each frame, the owner writes points into `getChannel(type).points`,
 *    then calls `submit(descriptors)` which bumps the generation counter
 *    and wakes workers.
 * 3. After one tick of latency the owner calls `isFrameComplete()`; if
 *    true, results are readable from `getChannel(type).results`.
 * 4. `terminate()` cleanly shuts down all workers.
 *
 * Intentionally a plain class (not a BaseEntity) — the pool has no
 * per-tick lifecycle of its own. The owning `CpuQueryCoordinator` entity
 * constructs, drives, and destroys it.
 */
export class QueryWorkerPool {
  readonly workerCount: number;

  private workers: Worker[] = [];
  private controlSab: SharedArrayBuffer;
  private control: Int32Array;

  private terrainChannel: PoolChannel;
  private waterChannel: PoolChannel;
  private windChannel: PoolChannel;

  /**
   * Last generation the main thread submitted. Also acts as the signal
   * workers wait on (`Atomics.wait` until control[CTRL_GENERATION] !=
   * lastObserved).
   */
  private generation = 0;

  /**
   * True between `submit()` and `isFrameComplete()` returning true.
   * Prevents double-submit before a frame has been drained.
   */
  private frameInFlight = false;

  constructor(options: QueryWorkerPoolOptions) {
    this.workerCount = options.workerCount;

    this.controlSab = new SharedArrayBuffer(
      CTRL_TOTAL_INTS * Int32Array.BYTES_PER_ELEMENT,
    );
    this.control = new Int32Array(this.controlSab);

    this.terrainChannel = createChannel(options.terrain);
    this.waterChannel = createChannel(options.water);
    this.windChannel = createChannel(options.wind);

    const initChannels: QueryWorkerChannel[] = [
      channelToInit(this.terrainChannel),
      channelToInit(this.waterChannel),
      channelToInit(this.windChannel),
    ];

    for (let i = 0; i < options.workerCount; i++) {
      const worker = new Worker(new URL("./query-worker.ts", import.meta.url), {
        type: "module",
      });
      const msg: QueryWorkerInitMessage = {
        type: "init",
        workerIndex: i,
        workerCount: options.workerCount,
        controlSab: this.controlSab,
        channels: initChannels,
      };
      worker.postMessage(msg);
      this.workers.push(worker);
    }
  }

  getChannel(queryType: QueryTypeId): PoolChannel {
    switch (queryType) {
      case QUERY_TYPE_TERRAIN:
        return this.terrainChannel;
      case QUERY_TYPE_WATER:
        return this.waterChannel;
      case QUERY_TYPE_WIND:
        return this.windChannel;
    }
  }

  /**
   * Submit a frame of work. Pass one descriptor per query type that has
   * points to process this frame — types with zero points are omitted.
   *
   * The caller must have already populated each active channel's `points`
   * view before calling this.
   */
  submit(
    descriptors: Array<{ queryType: QueryTypeId; pointCount: number }>,
  ): void {
    if (this.frameInFlight) {
      console.warn(
        "[QueryWorkerPool] submit called while a frame is still in flight; dropping.",
      );
      return;
    }
    if (descriptors.length > MAX_DESCRIPTORS) {
      throw new Error(
        `[QueryWorkerPool] too many descriptors (${descriptors.length} > ${MAX_DESCRIPTORS})`,
      );
    }

    // Write descriptors into control block.
    for (let i = 0; i < descriptors.length; i++) {
      const d = descriptors[i];
      const base = CTRL_DESCRIPTORS_BASE + i * CTRL_DESCRIPTOR_STRIDE;
      this.control[base + CTRL_DESCRIPTOR_TYPE_ID] = d.queryType;
      this.control[base + CTRL_DESCRIPTOR_POINT_COUNT] = d.pointCount;
      this.control[base + CTRL_DESCRIPTOR_STRIDE_FIELD] = this.getChannel(
        d.queryType,
      ).resultStride;
      this.control[base + CTRL_DESCRIPTOR_RESERVED] = 0;
    }
    // Clear unused descriptor slots so stale data doesn't confuse workers.
    for (let i = descriptors.length; i < MAX_DESCRIPTORS; i++) {
      const base = CTRL_DESCRIPTORS_BASE + i * CTRL_DESCRIPTOR_STRIDE;
      this.control[base + CTRL_DESCRIPTOR_TYPE_ID] = 0;
      this.control[base + CTRL_DESCRIPTOR_POINT_COUNT] = 0;
      this.control[base + CTRL_DESCRIPTOR_STRIDE_FIELD] = 0;
      this.control[base + CTRL_DESCRIPTOR_RESERVED] = 0;
    }

    Atomics.store(this.control, CTRL_NUM_TYPES, descriptors.length);
    Atomics.store(this.control, CTRL_RESERVED, 0);
    // `remaining` must be set before `generation` is bumped, otherwise a
    // very-fast worker could finish and decrement past zero.
    Atomics.store(this.control, CTRL_REMAINING, this.workerCount);

    this.generation++;
    Atomics.store(this.control, CTRL_GENERATION, this.generation);
    Atomics.notify(this.control, CTRL_GENERATION, this.workerCount);

    this.frameInFlight = true;
  }

  /**
   * Non-blocking check: true when all workers have finished the most
   * recently submitted frame. Call once per tick before reading results.
   */
  isFrameComplete(): boolean {
    if (!this.frameInFlight) return true;
    const remaining = Atomics.load(this.control, CTRL_REMAINING);
    if (remaining === 0) {
      this.frameInFlight = false;
      return true;
    }
    return false;
  }

  terminate(): void {
    for (const worker of this.workers) {
      worker.postMessage({ type: "destroy" });
      worker.terminate();
    }
    this.workers.length = 0;
  }
}

/**
 * Compute a sensible default worker count: reserve cores for the main
 * thread, the cloth worker pool, and the browser compositor.
 */
export function defaultQueryWorkerCount(): number {
  const hardware =
    typeof navigator !== "undefined" && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 8;
  return Math.max(hardware - 4, 2);
}

function createChannel(spec: {
  maxPoints: number;
  resultStride: number;
  worldState?: readonly Uint32Array[];
  frameStateSab?: SharedArrayBuffer | null;
}): PoolChannel {
  const pointsSab = new SharedArrayBuffer(
    spec.maxPoints * STRIDE_PER_POINT * Float32Array.BYTES_PER_ELEMENT,
  );
  const resultsSab = new SharedArrayBuffer(
    spec.maxPoints * spec.resultStride * Float32Array.BYTES_PER_ELEMENT,
  );
  const paramsSab = new SharedArrayBuffer(
    PARAMS_FLOATS_PER_CHANNEL * Float32Array.BYTES_PER_ELEMENT,
  );
  const frameStateSab = spec.frameStateSab ?? null;
  return {
    pointsSab,
    resultsSab,
    paramsSab,
    frameStateSab,
    points: new Float32Array(pointsSab),
    results: new Float32Array(resultsSab),
    params: new Float32Array(paramsSab),
    frameState: frameStateSab ? new Float32Array(frameStateSab) : null,
    worldState: spec.worldState ?? [],
    maxPoints: spec.maxPoints,
    resultStride: spec.resultStride,
  };
}

function channelToInit(c: PoolChannel): QueryWorkerChannel {
  return {
    pointsSab: c.pointsSab,
    resultsSab: c.resultsSab,
    paramsSab: c.paramsSab,
    frameStateSab: c.frameStateSab,
    worldState: c.worldState,
    maxPoints: c.maxPoints,
    resultStride: c.resultStride,
  };
}
