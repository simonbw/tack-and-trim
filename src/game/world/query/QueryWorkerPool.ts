import {
  asyncProfiler,
  type AsyncOperationToken,
} from "../../../core/util/AsyncProfiler";
import { profiler } from "../../../core/util/Profiler";
import {
  BARRIER_TIMING_CALIBRATION_MS,
  BARRIER_TIMING_COMPUTE_END,
  BARRIER_TIMING_COMPUTE_START,
  BARRIER_TIMING_DECREMENT,
  BARRIER_TIMING_TYPE_FIRST_START_BASE,
  BARRIER_TIMING_TYPE_LAST_END_BASE,
  BARRIER_TIMING_WAKE,
  BARRIER_TIMINGS_PER_WORKER,
  CTRL_DESCRIPTORS_BASE,
  CTRL_DESCRIPTOR_POINT_COUNT,
  CTRL_DESCRIPTOR_RESERVED,
  CTRL_DESCRIPTOR_STRIDE,
  CTRL_DESCRIPTOR_STRIDE_FIELD,
  CTRL_DESCRIPTOR_TYPE_ID,
  CTRL_GENERATION,
  CTRL_NEXT_CHUNK_BASE,
  CTRL_NUM_TYPES,
  CTRL_REMAINING,
  CTRL_TOTAL_INTS,
  MAX_DESCRIPTORS,
  PARAMS_FLOATS_PER_CHANNEL,
  QUERY_TYPE_TERRAIN,
  QUERY_TYPE_WATER,
  QUERY_TYPE_WIND,
  type QueryTypeId,
  type QueryWorkerInitMessage,
  STACK_BYTES_PER_WORKER,
  STRIDE_PER_POINT,
  TIMINGS_FLOATS_PER_WORKER,
  type WasmChannelLayout,
  type WasmPartitionLayout,
} from "./query-worker-protocol";

/**
 * Lazily compile the query-wasm module the first time anyone asks for it.
 * Shared across all `QueryWorkerPool` instances; the result is a parsed
 * `WebAssembly.Module` that workers can independently instantiate against
 * the pool's shared `WebAssembly.Memory`.
 */
let wasmModulePromise: Promise<WebAssembly.Module> | null = null;
function getQueryWasmModule(): Promise<WebAssembly.Module> {
  if (!wasmModulePromise) {
    const url = new URL("./generated/query.wasm", import.meta.url);
    wasmModulePromise = WebAssembly.compileStreaming(fetch(url)).catch(
      (err) => {
        wasmModulePromise = null;
        throw err;
      },
    );
  }
  return wasmModulePromise;
}

const QUERY_TYPE_LABELS: Record<QueryTypeId, string> = {
  [QUERY_TYPE_TERRAIN]: "terrain",
  [QUERY_TYPE_WATER]: "water",
  [QUERY_TYPE_WIND]: "wind",
};

const ALL_QUERY_TYPES: readonly QueryTypeId[] = [
  QUERY_TYPE_TERRAIN,
  QUERY_TYPE_WATER,
  QUERY_TYPE_WIND,
];

/**
 * Per-query-type buffer set, all backed by the pool's shared
 * `WebAssembly.Memory`. The `points`/`params`/`results`/`frameState`
 * Float32Array views read and write directly into the same bytes the
 * wasm kernel touches, so the per-point math path makes no copies.
 * The coordinator does still copy the modifier table into `frameState`
 * once per frame, but that's outside the kernel hot path.
 *
 * The pool exposes the points/params/results views to managers (so
 * they can write inputs and read outputs); the kernel never touches
 * them through these views, only via the wasm pointers.
 */
interface PoolChannel {
  /** Byte offsets into `wasmMemory.buffer`. Stay valid for memory's lifetime. */
  pointsPtr: number;
  paramsPtr: number;
  resultsPtr: number;
  /** Modifiers buffer (water only); 0 for other types. */
  modifiersPtr: number;
  /** Float32Array views over the regions above. Re-derived on memory grow. */
  points: Float32Array;
  results: Float32Array;
  params: Float32Array;
  /** Modifiers view (water only); empty Float32Array for other types. */
  frameState: Float32Array | null;
  /** Per-buffer pointers for any packed world-state data this type needs. */
  worldStatePtrs: number[];
  worldStateLens: number[];
  maxPoints: number;
  resultStride: number;
}

export interface QueryWorkerPoolOptions {
  workerCount: number;
  terrain: ChannelOptions;
  water: ChannelOptions;
  wind: ChannelOptions;
}

export interface ChannelOptions {
  maxPoints: number;
  resultStride: number;
  /**
   * Optional immutable packed buffers (terrain DFS data, wave/tide/wind
   * mesh data). Copied **once** into the pool's shared `WebAssembly.Memory`
   * at level load. The pool surfaces the resulting offsets+lengths to
   * each worker so the wasm kernel can read them directly.
   *
   * Order is query-type-specific:
   *   - terrain: [packedTerrain]
   *   - water:   [packedWaveMesh, packedTideMesh]
   *   - wind:    [packedWindMesh]
   */
  worldState?: readonly Uint32Array[];
  /**
   * Optional frame-mutable state (water modifiers). The bytes live in
   * the pool's shared memory; main thread writes each frame, workers
   * read directly. Sized to the worst-case modifier table.
   */
  frameStateBytes?: number;
}

const PAGE_BYTES = 65536;
const ALIGN = 16;
const align = (n: number): number => (n + ALIGN - 1) & ~(ALIGN - 1);

/**
 * Manages a pool of web workers + a shared `WebAssembly.Memory` they
 * all read and write. The memory is partitioned manually by this pool
 * into per-channel regions (points / params / results / modifiers) plus
 * a tail region holding the immutable world-state buffers. Each worker
 * instantiates the query-wasm module against this memory and reads/
 * writes via integer offsets — no copies between JS and wasm.
 *
 * Lifecycle:
 * 1. `new QueryWorkerPool({...})` returns synchronously with `ready`
 *    pending. The synchronous parts (control SAB, timings SAB) are set
 *    up immediately; everything else (memory, partitioning, workers)
 *    happens inside `ready` once the wasm module finishes compiling.
 * 2. Callers await `ready` before flipping `coordinated` on managers.
 */
export class QueryWorkerPool {
  readonly workerCount: number;

  /**
   * Resolves once the shared memory is allocated, world state is copied
   * in, and workers have been posted their init messages. Until this
   * resolves, `submit()` is a no-op and `getChannel()` throws.
   */
  readonly ready: Promise<void>;

  private workers: Worker[] = [];
  private controlSab: SharedArrayBuffer;
  private control: Int32Array;

  private timingsSab: SharedArrayBuffer;
  private timingsView: Float32Array;

  private barrierTimingsSab: SharedArrayBuffer;
  private barrierTimingsView: Float64Array;
  private submitTime = 0;

  private inFlightTokens: (AsyncOperationToken | null)[] = [null, null, null];

  private wasmMemory: WebAssembly.Memory | null = null;
  private wasmModule: WebAssembly.Module | null = null;
  private terrainChannel: PoolChannel | null = null;
  private waterChannel: PoolChannel | null = null;
  private windChannel: PoolChannel | null = null;

  private generation = 0;
  private frameInFlight = false;
  private frameDonePromise: Promise<void> | null = null;
  private destroyed = false;

  /**
   * Per-type point count for the most recently submitted frame.
   * Updated each `submit()`. Exposed via `lastSubmittedPointCounts`
   * so benchmarks can sanity-check what workload the pool is actually
   * processing per frame.
   */
  readonly lastSubmittedPointCounts: Record<QueryTypeId, number> = {
    [QUERY_TYPE_TERRAIN]: 0,
    [QUERY_TYPE_WATER]: 0,
    [QUERY_TYPE_WIND]: 0,
  };

  constructor(options: QueryWorkerPoolOptions) {
    this.workerCount = options.workerCount;

    this.controlSab = new SharedArrayBuffer(
      CTRL_TOTAL_INTS * Int32Array.BYTES_PER_ELEMENT,
    );
    this.control = new Int32Array(this.controlSab);

    this.timingsSab = new SharedArrayBuffer(
      options.workerCount *
        TIMINGS_FLOATS_PER_WORKER *
        Float32Array.BYTES_PER_ELEMENT,
    );
    this.timingsView = new Float32Array(this.timingsSab);

    this.barrierTimingsSab = new SharedArrayBuffer(
      options.workerCount *
        BARRIER_TIMINGS_PER_WORKER *
        Float64Array.BYTES_PER_ELEMENT,
    );
    this.barrierTimingsView = new Float64Array(this.barrierTimingsSab);

    this.ready = this.initAsync(options);
  }

  /**
   * Compile the wasm module, allocate one shared `WebAssembly.Memory`
   * sized to fit all per-channel buffers + world state, partition it,
   * copy world state in, and ship init messages to workers.
   */
  private async initAsync(options: QueryWorkerPoolOptions): Promise<void> {
    const wasmModule = await getQueryWasmModule();
    if (this.destroyed) return;
    this.wasmModule = wasmModule;

    // The wasm module reserves linear-memory bytes [0, __heap_base) for
    // its own data section and stack. We have to start our manual
    // partition above that — overlapping would corrupt the wasm's own
    // statics (e.g. WORLD_STATE) and crash the kernel.
    const heapBase = await probeHeapBase(wasmModule);
    const partition = computePartition(options, heapBase, options.workerCount);
    const initialPages = Math.ceil(partition.totalBytes / PAGE_BYTES) + 16;
    const memory = new WebAssembly.Memory({
      initial: initialPages,
      maximum: 65536, // 4 GiB cap (wasm32 max).
      shared: true,
    });
    this.wasmMemory = memory;

    // Copy world state into the shared memory at the offsets the
    // partition reserved. After this point the original Uint32Arrays are
    // no longer needed.
    copyWorldState(memory, partition.terrain, options.terrain.worldState ?? []);
    copyWorldState(memory, partition.water, options.water.worldState ?? []);
    copyWorldState(memory, partition.wind, options.wind.worldState ?? []);

    this.terrainChannel = makeChannel(memory, partition.terrain);
    this.waterChannel = makeChannel(memory, partition.water);
    this.windChannel = makeChannel(memory, partition.wind);

    for (let i = 0; i < options.workerCount; i++) {
      const worker = new Worker(new URL("./query-worker.ts", import.meta.url), {
        type: "module",
      });
      worker.addEventListener("error", (ev) => {
        console.error(
          `[QueryWorkerPool] worker ${i} error:`,
          ev.message,
          ev.filename,
          ev.lineno,
        );
      });
      worker.addEventListener("messageerror", (ev) => {
        console.error(`[QueryWorkerPool] worker ${i} messageerror:`, ev);
      });
      const msg: QueryWorkerInitMessage = {
        type: "init",
        workerIndex: i,
        workerCount: options.workerCount,
        controlSab: this.controlSab,
        timingsSab: this.timingsSab,
        barrierTimingsSab: this.barrierTimingsSab,
        mainTimeOrigin: performance.timeOrigin,
        wasmMemory: memory,
        wasmModule,
        partition,
      };
      worker.postMessage(msg);
      this.workers.push(worker);
    }
  }

  getChannel(queryType: QueryTypeId): PoolChannel {
    const channel =
      queryType === QUERY_TYPE_TERRAIN
        ? this.terrainChannel
        : queryType === QUERY_TYPE_WATER
          ? this.waterChannel
          : this.windChannel;
    if (!channel) {
      throw new Error(
        "[QueryWorkerPool] getChannel called before pool.ready resolved",
      );
    }
    // Memory growth detaches typed-array views. We don't grow during
    // normal operation (initial pages cover everything), but if a
    // future change introduces growth, the views need to be re-derived.
    if (this.wasmMemory && channel.points.buffer !== this.wasmMemory.buffer) {
      this.refreshChannelViews(channel);
    }
    return channel;
  }

  private refreshChannelViews(channel: PoolChannel): void {
    if (!this.wasmMemory) return;
    const buf = this.wasmMemory.buffer;
    channel.points = new Float32Array(
      buf,
      channel.pointsPtr,
      channel.maxPoints * STRIDE_PER_POINT,
    );
    channel.params = new Float32Array(
      buf,
      channel.paramsPtr,
      PARAMS_FLOATS_PER_CHANNEL,
    );
    channel.results = new Float32Array(
      buf,
      channel.resultsPtr,
      channel.maxPoints * channel.resultStride,
    );
    if (channel.modifiersPtr !== 0 && channel.frameState) {
      channel.frameState = new Float32Array(
        buf,
        channel.modifiersPtr,
        channel.frameState.length,
      );
    }
  }

  submit(
    descriptors: Array<{ queryType: QueryTypeId; pointCount: number }>,
  ): void {
    if (!this.terrainChannel) {
      // Pool not ready yet — drop the submit silently. Managers will
      // see no in-flight frame and skip distribution next tick. The
      // coordinator only flips `coordinated` after `ready` resolves,
      // so this branch is just a defensive guard.
      return;
    }
    if (this.frameInFlight) {
      throw new Error(
        "[QueryWorkerPool] submit called while a frame is still in flight — did the caller forget to await awaitFrameComplete()?",
      );
    }
    if (descriptors.length > MAX_DESCRIPTORS) {
      throw new Error(
        `[QueryWorkerPool] too many descriptors (${descriptors.length} > ${MAX_DESCRIPTORS})`,
      );
    }

    // Reset per-type point counts so types skipped this frame
    // report 0 instead of last frame's stale value.
    this.lastSubmittedPointCounts[QUERY_TYPE_TERRAIN] = 0;
    this.lastSubmittedPointCounts[QUERY_TYPE_WATER] = 0;
    this.lastSubmittedPointCounts[QUERY_TYPE_WIND] = 0;
    for (let i = 0; i < descriptors.length; i++) {
      const d = descriptors[i];
      const base = CTRL_DESCRIPTORS_BASE + i * CTRL_DESCRIPTOR_STRIDE;
      this.control[base + CTRL_DESCRIPTOR_TYPE_ID] = d.queryType;
      this.control[base + CTRL_DESCRIPTOR_POINT_COUNT] = d.pointCount;
      this.control[base + CTRL_DESCRIPTOR_STRIDE_FIELD] = this.getChannel(
        d.queryType,
      ).resultStride;
      this.control[base + CTRL_DESCRIPTOR_RESERVED] = 0;
      this.lastSubmittedPointCounts[d.queryType] = d.pointCount;
    }
    for (let i = descriptors.length; i < MAX_DESCRIPTORS; i++) {
      const base = CTRL_DESCRIPTORS_BASE + i * CTRL_DESCRIPTOR_STRIDE;
      this.control[base + CTRL_DESCRIPTOR_TYPE_ID] = 0;
      this.control[base + CTRL_DESCRIPTOR_POINT_COUNT] = 0;
      this.control[base + CTRL_DESCRIPTOR_STRIDE_FIELD] = 0;
      this.control[base + CTRL_DESCRIPTOR_RESERVED] = 0;
    }

    for (const d of descriptors) {
      this.inFlightTokens[d.queryType] = asyncProfiler.startAsync(
        `QueryWorkers.${QUERY_TYPE_LABELS[d.queryType]}`,
      );
    }

    // Reset every dynamic-chunk counter, including unused descriptor
    // slots: workers iterate descriptor slots in order and a stale
    // counter from last frame would mis-attribute work.
    for (let i = 0; i < MAX_DESCRIPTORS; i++) {
      Atomics.store(this.control, CTRL_NEXT_CHUNK_BASE + i, 0);
    }

    Atomics.store(this.control, CTRL_NUM_TYPES, descriptors.length);
    Atomics.store(this.control, CTRL_REMAINING, this.workerCount);

    this.generation++;
    this.submitTime = performance.now();
    Atomics.store(this.control, CTRL_GENERATION, this.generation);
    Atomics.notify(this.control, CTRL_GENERATION, this.workerCount);

    this.frameInFlight = true;
  }

  awaitFrameComplete(): Promise<void> {
    if (!this.frameInFlight) return Promise.resolve();
    if (!this.frameDonePromise) {
      this.frameDonePromise = this.doAwaitFrameComplete().finally(() => {
        this.frameDonePromise = null;
      });
    }
    return this.frameDonePromise;
  }

  private async doAwaitFrameComplete(): Promise<void> {
    const waitStart = performance.now();
    let current: number;
    while ((current = Atomics.load(this.control, CTRL_REMAINING)) !== 0) {
      const { async, value } = Atomics.waitAsync(
        this.control,
        CTRL_REMAINING,
        current,
      );
      if (async) await value;
    }
    const barrierEnd = performance.now();
    profiler.recordElapsed(
      "QueryWorkerPool.awaitFrameComplete",
      barrierEnd - waitStart,
    );
    this.reportBarrierBreakdown(barrierEnd);
    this.reportFrameTimings();
    this.frameInFlight = false;
  }

  /**
   * Decompose the barrier wall time into phases. Each frame the
   * "critical-path worker" — the one whose finish actually drives
   * `barrierEnd` — is identified by the latest decrement timestamp;
   * we attribute the bulk of the barrier to that worker's wake delay
   * and compute time so the labels sum (within a few hundred µs) to
   * the `awaitFrameComplete` total:
   *
   *   - `barrier.wakeLatency`     — submit → critical worker's wake
   *                                 (OS scheduler delay before its compute starts)
   *   - `barrier.workerCompute`   — critical worker's compute_end - compute_start
   *                                 (actual on-CPU time of the slowest worker)
   *   - `barrier.notifyToMain`    — critical worker's decrement → main wakes
   *
   * Plus one orthogonal load-balance metric:
   *
   *   - `barrier.workerImbalance` — max(compute_end) - min(compute_end)
   *                                 (slack between fastest and slowest worker —
   *                                 if zero, the barrier could not be improved
   *                                 by reslicing work)
   */
  private reportBarrierBreakdown(barrierEnd: number): void {
    const submit = this.submitTime;
    const t = this.barrierTimingsView;
    const stride = BARRIER_TIMINGS_PER_WORKER;

    let critWake = 0;
    let critStart = 0;
    let critEnd = 0;
    let critDecrement = -Infinity;
    let maxComputeEnd = -Infinity;
    let minComputeEnd = Infinity;
    let anyValid = false;
    for (let w = 0; w < this.workerCount; w++) {
      const wake = t[w * stride + BARRIER_TIMING_WAKE];
      const start = t[w * stride + BARRIER_TIMING_COMPUTE_START];
      const end = t[w * stride + BARRIER_TIMING_COMPUTE_END];
      const decrement = t[w * stride + BARRIER_TIMING_DECREMENT];
      // Workers that didn't run this frame leave stale slots.
      if (wake < submit) continue;
      anyValid = true;
      if (end > maxComputeEnd) maxComputeEnd = end;
      if (end < minComputeEnd) minComputeEnd = end;
      if (decrement > critDecrement) {
        critDecrement = decrement;
        critWake = wake;
        critStart = start;
        critEnd = end;
      }
    }

    if (!anyValid) return;

    profiler.recordElapsed("barrier.wakeLatency", critWake - submit);
    profiler.recordElapsed("barrier.workerCompute", critEnd - critStart);
    profiler.recordElapsed(
      "barrier.notifyToMain",
      Math.max(0, barrierEnd - critDecrement),
    );
    profiler.recordElapsed(
      "barrier.workerImbalance",
      maxComputeEnd - minComputeEnd,
    );

    // Calibration probe. Only one worker writes a non-zero value per
    // frame (round-robin) — the others write 0. Picking the max picks
    // out that one sample.
    let probeMs = 0;
    for (let w = 0; w < this.workerCount; w++) {
      const v = t[w * stride + BARRIER_TIMING_CALIBRATION_MS];
      if (v > probeMs) probeMs = v;
    }
    if (probeMs > 0) {
      profiler.recordElapsed("barrier.calibrationProbe", probeMs);
    }

    this.reportPerTypeWalls(submit);
  }

  /**
   * For each query type, find when its first chunk started and its last
   * chunk ended (across all workers that touched it), and report two
   * labels per type:
   *
   *   - `barrier.<type>.firstStart` — submit → first worker arrived at this type
   *   - `barrier.<type>.lastEnd`    — submit → last chunk for this type completed
   *
   * The active span of a type is `lastEnd − firstStart`. With dynamic
   * chunking, spans across types overlap (worker A finishes type 0 and
   * starts type 1 while worker B is still on type 0), so the per-type
   * spans don't sum to the barrier wall — they describe when each type
   * was *actively in flight on at least one worker*. The `lastEnd` is the
   * moment that type goes off the critical path, which is what tells you
   * "type X gates the barrier" or "type Y was already done by 2 ms".
   */
  private reportPerTypeWalls(submit: number): void {
    const t = this.barrierTimingsView;
    const stride = BARRIER_TIMINGS_PER_WORKER;
    for (const typeId of ALL_QUERY_TYPES) {
      let minStart = Infinity;
      let maxEnd = -Infinity;
      for (let w = 0; w < this.workerCount; w++) {
        const start =
          t[w * stride + BARRIER_TIMING_TYPE_FIRST_START_BASE + typeId];
        const end = t[w * stride + BARRIER_TIMING_TYPE_LAST_END_BASE + typeId];
        // Sentinel 0 = worker didn't touch this type; ignore.
        if (start === 0 || start < submit) continue;
        if (start < minStart) minStart = start;
        if (end > maxEnd) maxEnd = end;
      }
      if (minStart === Infinity) continue; // nobody touched this type
      const label = QUERY_TYPE_LABELS[typeId];
      profiler.recordElapsed(`barrier.${label}.firstStart`, minStart - submit);
      profiler.recordElapsed(`barrier.${label}.lastEnd`, maxEnd - submit);
    }
  }

  private reportFrameTimings(): void {
    for (const typeId of ALL_QUERY_TYPES) {
      const token = this.inFlightTokens[typeId];
      if (!token) continue;
      let sumMs = 0;
      for (let w = 0; w < this.workerCount; w++) {
        sumMs += this.timingsView[w * TIMINGS_FLOATS_PER_WORKER + typeId];
      }
      asyncProfiler.endAsync(token, sumMs);
      this.inFlightTokens[typeId] = null;
      // Per-point CPU cost (µs/pt). Sum across workers of compute time
      // divided by point count = average per-point cost on whichever
      // worker handled it, giving an apples-to-apples comparison with
      // `tests/query-microbenchmark.spec.ts`'s ns/pt numbers (the bench
      // computes `wallClockMs * 1e6 / (pointCount * iterations)`, which
      // is the same quantity for a perfectly-balanced cell).
      const pointCount = this.lastSubmittedPointCounts[typeId];
      if (pointCount > 0 && sumMs > 0) {
        profiler.recordElapsed(
          `query.${QUERY_TYPE_LABELS[typeId]}.usPerPt`,
          (sumMs * 1000) / pointCount,
        );
      }
    }
  }

  terminate(): void {
    this.destroyed = true;
    for (const worker of this.workers) {
      worker.postMessage({ type: "destroy" });
      worker.terminate();
    }
    this.workers.length = 0;
    for (let t = 0; t < this.inFlightTokens.length; t++) {
      const token = this.inFlightTokens[t];
      if (token) {
        asyncProfiler.endAsync(token, 0);
        this.inFlightTokens[t] = null;
      }
    }
  }
}

/**
 * Optional override for the worker pool size, read from localStorage
 * (`queryWorkerCount`). Mainly useful for benchmarks that want to
 * sweep over worker counts without recompiling.
 */
function getQueryWorkerCountOverride(): number | null {
  if (typeof localStorage === "undefined") return null;
  const stored = localStorage.getItem("queryWorkerCount");
  if (stored == null) return null;
  const n = parseInt(stored, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function defaultQueryWorkerCount(): number {
  const override = getQueryWorkerCountOverride();
  if (override != null) return override;

  const hardware =
    typeof navigator !== "undefined" && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 8;
  return Math.max(hardware - 4, 2);
}

// ---------------------------------------------------------------------------
// Partitioning. Computes byte offsets for every region the pool needs:
// per-channel buffers (points/params/results/modifiers) plus world-state
// blobs. The result is communicated to workers via the init message so
// they can build matching typed-array views and call into wasm with
// matching pointers.
// ---------------------------------------------------------------------------

/**
 * Instantiate the module once with a throwaway memory just to read its
 * `__heap_base` global — the lowest byte we're allowed to use without
 * stomping on the linker-laid-out data + stack region. The throwaway
 * instance is dropped immediately.
 */
async function probeHeapBase(module: WebAssembly.Module): Promise<number> {
  const probeMemory = new WebAssembly.Memory({
    initial: 17,
    maximum: 17,
    shared: true,
  });
  const probe = await WebAssembly.instantiate(module, {
    env: { memory: probeMemory },
  });
  return (probe.exports.__heap_base as WebAssembly.Global).value as number;
}

function computePartition(
  options: QueryWorkerPoolOptions,
  heapBase: number,
  workerCount: number,
): WasmPartitionLayout {
  let cursor = heapBase;

  // Per-worker shadow stacks come first so their byte addresses are
  // small (the wasm `__stack_pointer` is i32, so any address fits, but
  // grouping them up front keeps the layout easier to reason about).
  // Each worker's stack grows down from `top` toward `top - STACK_BYTES`.
  cursor = align(cursor);
  const stackTops: number[] = [];
  for (let i = 0; i < workerCount; i++) {
    cursor += STACK_BYTES_PER_WORKER;
    stackTops.push(cursor);
  }

  const carve = (spec: ChannelOptions): WasmChannelLayout => {
    const pointsBytes =
      spec.maxPoints * STRIDE_PER_POINT * Float32Array.BYTES_PER_ELEMENT;
    const paramsBytes =
      PARAMS_FLOATS_PER_CHANNEL * Float32Array.BYTES_PER_ELEMENT;
    const resultsBytes =
      spec.maxPoints * spec.resultStride * Float32Array.BYTES_PER_ELEMENT;
    const modifiersBytes = spec.frameStateBytes ?? 0;

    cursor = align(cursor);
    const pointsPtr = cursor;
    cursor += pointsBytes;
    cursor = align(cursor);
    const paramsPtr = cursor;
    cursor += paramsBytes;
    cursor = align(cursor);
    const resultsPtr = cursor;
    cursor += resultsBytes;
    let modifiersPtr = 0;
    if (modifiersBytes > 0) {
      cursor = align(cursor);
      modifiersPtr = cursor;
      cursor += modifiersBytes;
    }

    const worldState = spec.worldState ?? [];
    const worldStatePtrs: number[] = [];
    const worldStateLens: number[] = [];
    for (const blob of worldState) {
      cursor = align(cursor);
      worldStatePtrs.push(cursor);
      worldStateLens.push(blob.length); // u32 elements
      cursor += blob.byteLength;
    }

    return {
      pointsPtr,
      pointsBytes,
      paramsPtr,
      paramsBytes,
      resultsPtr,
      resultsBytes,
      modifiersPtr,
      modifiersBytes,
      worldStatePtrs,
      worldStateLens,
      maxPoints: spec.maxPoints,
      resultStride: spec.resultStride,
    };
  };

  const terrain = carve(options.terrain);
  const water = carve(options.water);
  const wind = carve(options.wind);

  return {
    terrain,
    water,
    wind,
    stackTops,
    totalBytes: cursor,
  };
}

function copyWorldState(
  memory: WebAssembly.Memory,
  layout: WasmChannelLayout,
  blobs: readonly Uint32Array[],
): void {
  for (let i = 0; i < blobs.length; i++) {
    const ptr = layout.worldStatePtrs[i];
    if (ptr === undefined) continue;
    const dst = new Uint32Array(memory.buffer, ptr, blobs[i].length);
    dst.set(blobs[i]);
  }
}

function makeChannel(
  memory: WebAssembly.Memory,
  layout: WasmChannelLayout,
): PoolChannel {
  const buf = memory.buffer;
  return {
    pointsPtr: layout.pointsPtr,
    paramsPtr: layout.paramsPtr,
    resultsPtr: layout.resultsPtr,
    modifiersPtr: layout.modifiersPtr,
    points: new Float32Array(
      buf,
      layout.pointsPtr,
      layout.maxPoints * STRIDE_PER_POINT,
    ),
    results: new Float32Array(
      buf,
      layout.resultsPtr,
      layout.maxPoints * layout.resultStride,
    ),
    params: new Float32Array(buf, layout.paramsPtr, PARAMS_FLOATS_PER_CHANNEL),
    frameState:
      layout.modifiersPtr !== 0 && layout.modifiersBytes > 0
        ? new Float32Array(
            buf,
            layout.modifiersPtr,
            layout.modifiersBytes / Float32Array.BYTES_PER_ELEMENT,
          )
        : null,
    worldStatePtrs: layout.worldStatePtrs,
    worldStateLens: layout.worldStateLens,
    maxPoints: layout.maxPoints,
    resultStride: layout.resultStride,
  };
}
