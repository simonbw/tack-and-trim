/**
 * Shared-memory protocol between the main thread and query workers.
 *
 * One pool of workers handles all query types (terrain, water, wind).
 * The pool owns a single `WebAssembly.Memory({shared: true})`. All
 * per-frame buffers (points, params, results, modifiers) and all
 * immutable world-state blobs (packed terrain / wave / tide / wind
 * meshes) live inside that memory at offsets the pool partitions
 * manually. Both the JS-CPU dispatch path and the wasm dispatch path
 * read and write the same bytes — no copies.
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
// Control SAB layout (Int32Array view).
// ---------------------------------------------------------------------------

/** Generation counter. Bumped by main thread each frame to signal work. */
export const CTRL_GENERATION = 0;

/** Remaining workers that haven't finished the current generation's work. */
export const CTRL_REMAINING = 1;

/** Number of distinct query types with work this frame. */
export const CTRL_NUM_TYPES = 2;

/** Reserved for future use (padding to 16-byte alignment). */
export const CTRL_RESERVED = 3;

/**
 * Start of the per-query-type descriptors. Each descriptor is 4 Int32
 * entries: [typeId, pointCount, stride, /* reserved * / 0].
 */
export const CTRL_DESCRIPTORS_BASE = 4;
export const CTRL_DESCRIPTOR_STRIDE = 4;
export const CTRL_DESCRIPTOR_TYPE_ID = 0;
export const CTRL_DESCRIPTOR_POINT_COUNT = 1;
export const CTRL_DESCRIPTOR_STRIDE_FIELD = 2;
export const CTRL_DESCRIPTOR_RESERVED = 3;

export const MAX_DESCRIPTORS = 3;
export const CTRL_TOTAL_INTS =
  CTRL_DESCRIPTORS_BASE + MAX_DESCRIPTORS * CTRL_DESCRIPTOR_STRIDE;

/**
 * Profiling: each worker writes its per-query-type compute time (ms)
 * into its own slot of a shared Float32Array on `timingsSab`. Layout
 * is `[workerIndex * TIMINGS_FLOATS_PER_WORKER + typeId]`.
 */
export const TIMINGS_FLOATS_PER_WORKER = MAX_DESCRIPTORS;

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
  /**
   * Engine selector for the per-point math:
   *   "js"   — pure-TypeScript ports in `*-math.ts` (the original CPU path)
   *   "wasm" — Rust→WASM kernel from `pipeline/query-wasm`
   */
  cpuEngine: "js" | "wasm";
  /**
   * The shared `WebAssembly.Memory` the pool allocated. Workers build
   * Float32Array views over `wasmMemory.buffer` for the JS dispatch
   * path, and (when `cpuEngine === "wasm"`) instantiate the wasm
   * module against this memory so its kernel reads/writes the same
   * bytes — no copies between JS and wasm.
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

/** Sent to tell a worker to exit its loop and shut down. */
export interface QueryWorkerDestroyMessage {
  type: "destroy";
}

export type QueryWorkerMessage =
  | QueryWorkerInitMessage
  | QueryWorkerDestroyMessage;
