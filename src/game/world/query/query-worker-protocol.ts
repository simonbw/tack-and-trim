/**
 * Shared-memory protocol between the main thread and query workers.
 *
 * One pool of workers handles all query types (terrain, water, wind).
 * The pool owns a single `WebAssembly.Memory({shared: true})`. All
 * per-frame buffers (points, params, results, modifiers) and all
 * immutable world-state blobs (packed terrain / wave / tide / wind
 * meshes) live inside that memory at offsets the pool partitions
 * manually. Each worker instantiates the query-wasm module against
 * this shared memory and reads/writes via integer offsets — no copies.
 *
 * A separate small `controlSab` (Int32Array) drives a generation-counter
 * handshake so workers can `Atomics.wait`/`notify` to synchronize
 * frames; this is unrelated to the wasm memory.
 */

/**
 * Query types the worker pool can dispatch. The value is used as an
 * integer tag in the work-item list, so keep the numbers stable.
 */
export const QUERY_TYPE_TERRAIN = 0;
export const QUERY_TYPE_WATER = 1;
export const QUERY_TYPE_WIND = 2;

export type QueryTypeId =
  | typeof QUERY_TYPE_TERRAIN
  | typeof QUERY_TYPE_WATER
  | typeof QUERY_TYPE_WIND;

/** Number of `Float32Array` elements per query point (x, y). */
export const STRIDE_PER_POINT = 2;

// ---------------------------------------------------------------------------
// Shared layout constants — single source of truth for the TS / Rust / WGSL
// boundary. These are mirrored in Rust at `pipeline/query-wasm/src/protocol.rs`
// (auto-generated from this file by `pipeline/query-wasm/build.rs`). When you
// change a value here, run `npm run build-query-wasm` to regenerate the Rust
// constants. Do not duplicate these values inline elsewhere — re-export from
// here.
// ---------------------------------------------------------------------------

/**
 * Maximum number of wave sources used by water mesh / Gerstner shaders.
 * Used by both the wave physics manager (mesh array sizing) and the
 * water query pipeline.
 */
export const MAX_WAVE_SOURCES = 8;

/**
 * Maximum number of water modifiers (wakes / foam) per frame. Sized for
 * the per-frame GPU storage buffer and for the SAB-backed CPU mirror.
 */
export const MAX_MODIFIERS = 16384;

/**
 * Number of `f32` slots per modifier in the modifier buffer. See
 * `WaterResources.ts` for the per-slot layout.
 */
export const FLOATS_PER_MODIFIER = 14;

// ---------------------------------------------------------------------------
// Control SAB layout (Int32Array view).
// ---------------------------------------------------------------------------

/** Generation counter. Bumped by main thread each frame to signal work. */
export const CTRL_GENERATION = 0;

/** Remaining workers that haven't finished the current generation's work. */
export const CTRL_REMAINING = 1;

/** Number of distinct query types with work this frame. */
export const CTRL_NUM_TYPES = 2;

/**
 * Start of the per-query-type descriptors. Each descriptor is 4 Int32
 * entries: [typeId, pointCount, stride, /* reserved * / 0].
 */
export const CTRL_DESCRIPTORS_BASE = 3;
export const CTRL_DESCRIPTOR_STRIDE = 4;
export const CTRL_DESCRIPTOR_TYPE_ID = 0;
export const CTRL_DESCRIPTOR_POINT_COUNT = 1;
export const CTRL_DESCRIPTOR_STRIDE_FIELD = 2;
export const CTRL_DESCRIPTOR_RESERVED = 3;

export const MAX_DESCRIPTORS = 3;

/**
 * Per-descriptor "next chunk" atomic counter. Workers grab work by
 * `Atomics.add(control, CTRL_NEXT_CHUNK_BASE + i, 1)`; the returned
 * index multiplied by `CHUNK_SIZE` gives the start point. This replaces
 * the static `pointCount / workerCount` slicing with dynamic
 * work-stealing — fast workers (P-cores) naturally absorb more chunks
 * than slow ones (E-cores) and per-frame load skew is self-balancing.
 *
 * Main resets all `MAX_DESCRIPTORS` slots to 0 in `submit()`.
 */
export const CTRL_NEXT_CHUNK_BASE =
  CTRL_DESCRIPTORS_BASE + MAX_DESCRIPTORS * CTRL_DESCRIPTOR_STRIDE;
export const CTRL_TOTAL_INTS = CTRL_NEXT_CHUNK_BASE + MAX_DESCRIPTORS;

/**
 * Chunk size (number of query points per atomic-grab). Per-frame point
 * counts on real levels are small (water/wind ~200, terrain ~20), so
 * chunks must be small enough that all workers get multiple chunks per
 * type — otherwise we collapse to one-worker-per-type. Past ~32, the
 * load imbalance between fastest and slowest worker dominates.
 *
 * Sweep on sanJuanIslands, headless, 6 workers (median of 3 5s runs):
 *   chunk=4   → tick.query 0.31 ms, imbalance 0.14 ms
 *   chunk=8   → tick.query 0.29 ms, imbalance 0.17 ms
 *   chunk=16  → tick.query 0.29 ms, imbalance 0.37 ms
 *   chunk=32  → tick.query 0.28 ms, imbalance 0.62 ms
 *   chunk=64  → tick.query 0.28 ms, imbalance 1.95 ms (visible spikes)
 *
 * The kernel is fast enough that dispatch overhead is in the noise;
 * imbalance is the constraint. 8 keeps imbalance comfortably low while
 * absorbing some of the per-call overhead of the smallest chunks.
 */
export const CHUNK_SIZE = 8;

/**
 * Profiling: each worker writes its per-query-type compute time (ms)
 * into its own slot of a shared Float32Array on `timingsSab`. Layout
 * is `[workerIndex * TIMINGS_FLOATS_PER_WORKER + typeId]`.
 */
export const TIMINGS_FLOATS_PER_WORKER = MAX_DESCRIPTORS;

/**
 * Per-worker barrier timestamps (Float64, ms from `performance.now()`).
 * Written by workers each frame and read by main after the barrier resolves
 * to diagnose the wall-clock gap between worker compute and barrier wait.
 *
 * Layout: `[workerIndex * BARRIER_TIMINGS_PER_WORKER + offset]`.
 *
 * Slots:
 *   - WAKE          — when this worker's `Atomics.wait` returned for this frame
 *   - COMPUTE_START — right before the first per-type dispatch
 *   - COMPUTE_END   — right after the last per-type dispatch
 *   - DECREMENT     — right before the worker's `Atomics.sub(REMAINING, 1)`
 *
 * Float64 because timestamps are sub-ms-resolution `performance.now()` values
 * that can be in the millions of ms; Float32 would lose precision.
 */
export const BARRIER_TIMING_WAKE = 0;
export const BARRIER_TIMING_COMPUTE_START = 1;
export const BARRIER_TIMING_COMPUTE_END = 2;
export const BARRIER_TIMING_DECREMENT = 3;
/**
 * Per-type span: when did this worker's first chunk for type X start, and
 * when did its last chunk for type X end? Sentinel 0 means the worker
 * never touched that type this frame (skip when aggregating).
 */
export const BARRIER_TIMING_TYPE_FIRST_START_BASE = 4; // +0..+2 by typeId
export const BARRIER_TIMING_TYPE_LAST_END_BASE = 7; // +0..+2 by typeId
/**
 * Wall time (ms) the worker spent running `calibration_probe` on the
 * frames it ran. Pure-compute, no memory access — slow values here mean
 * the worker is being CPU-throttled / descheduled, not waiting on RAM.
 *
 * Workers stagger the probe so only one runs it per frame (round-robin
 * by `generation % workerCount`). That keeps the fixed-cost overhead
 * out of the critical path while still sampling every worker over
 * windows of seconds.
 */
export const BARRIER_TIMING_CALIBRATION_MS = 10;
export const BARRIER_TIMINGS_PER_WORKER = 11;
/**
 * How many iterations of `calibration_probe` to run on probe frames.
 * Tuned so the probe takes ~20 µs on a P-core — measurable above
 * `performance.now()` jitter without inflating the critical path.
 */
export const CALIBRATION_PROBE_ITERATIONS = 5000;

/**
 * Per-channel byte offsets into the pool's shared `WebAssembly.Memory`.
 * The pool computes these once (in `computePartition`) and ships them
 * to every worker via `QueryWorkerInitMessage`. Workers build matching
 * Float32Array views and call `process_*_batch` with these offsets.
 */
export interface WasmChannelLayout {
  pointsPtr: number;
  pointsBytes: number;
  paramsPtr: number;
  paramsBytes: number;
  resultsPtr: number;
  resultsBytes: number;
  /** Modifiers buffer offset (water only). 0 for other types. */
  modifiersPtr: number;
  modifiersBytes: number;
  /**
   * Per-type packed world-state buffers, in the same order the channel
   * options provided them. Pointers are byte offsets, lengths are u32
   * element counts.
   */
  worldStatePtrs: number[];
  worldStateLens: number[];
  maxPoints: number;
  resultStride: number;
}

export interface WasmPartitionLayout {
  terrain: WasmChannelLayout;
  water: WasmChannelLayout;
  wind: WasmChannelLayout;
  /**
   * Per-worker shadow-stack tops (byte addresses, indexed by workerIndex).
   * Each worker writes this value into its `__stack_pointer` global at
   * init so its shadow stack lives in its own `[top - STACK_BYTES, top)`
   * region rather than the linker default. See `STACK_BYTES_PER_WORKER`.
   */
  stackTops: number[];
  /** Total bytes the partition uses; lower bound for memory's initial size. */
  totalBytes: number;
}

/**
 * Init message sent once to each worker when it starts. Workers then
 * enter a wait-loop and never need another `postMessage`.
 */
export interface QueryWorkerInitMessage {
  type: "init";
  workerIndex: number;
  workerCount: number;
  controlSab: SharedArrayBuffer;
  /** Per-worker per-type compute time (ms), Float32Array-viewed. */
  timingsSab: SharedArrayBuffer;
  /** Per-worker barrier timestamps (ms, Float64Array-viewed). */
  barrierTimingsSab: SharedArrayBuffer;
  /**
   * Main thread's `performance.timeOrigin`. Workers compute their
   * own offset (`performance.timeOrigin - mainTimeOrigin`) once at init
   * and add it to every `performance.now()` they record into the
   * barrier-timings SAB, so the values are comparable to main's
   * `performance.now()` directly.
   */
  mainTimeOrigin: number;
  /**
   * The shared `WebAssembly.Memory` the pool allocated. Workers
   * instantiate the wasm module against this memory so its kernel
   * reads/writes the same bytes the main thread populates — no copies
   * between JS and wasm.
   */
  wasmMemory: WebAssembly.Memory;
  /** Precompiled query-wasm module, instantiated per worker. */
  wasmModule: WebAssembly.Module;
  /** Byte offsets into `wasmMemory` for every channel. */
  partition: WasmPartitionLayout;
}

/**
 * Fixed size of each per-channel params region, in Float32 entries.
 * Generous enough to hold scalar uniforms plus small inline tables.
 */
export const PARAMS_FLOATS_PER_CHANNEL = 128;

/**
 * Bytes of shadow-stack space reserved per worker in the pool's shared
 * `WebAssembly.Memory`. Wasm globals (including the shadow-stack pointer
 * that the linker generates) are per-Instance, but the *memory* the
 * stack lives in is shared across every Instance. Each worker's
 * Instance ships with the linker's default `__stack_pointer = 1 MiB`, so
 * by default every worker's stack frames overlap in `[0, 1 MiB)` — fine
 * for kernels whose locals fit in wasm registers, fatal for paths that
 * spill to the shadow stack (any closure with captures, large structs,
 * etc.). To prevent the overlap, the pool carves a contiguous region of
 * `workerCount * STACK_BYTES_PER_WORKER` bytes above heap_base and gives
 * each worker its own slot via the exported `__stack_pointer` global.
 *
 * 1 MiB matches the linker's default stack size, which is generous for
 * our kernels (deepest call chain is the IDW gradient closure inside
 * `compute_terrain_height_and_gradient`).
 */
export const STACK_BYTES_PER_WORKER = 1 << 20;

/** Sent to tell a worker to exit its loop and shut down. */
export interface QueryWorkerDestroyMessage {
  type: "destroy";
}

export type QueryWorkerMessage =
  | QueryWorkerInitMessage
  | QueryWorkerDestroyMessage;
