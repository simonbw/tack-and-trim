/**
 * Shared-memory protocol between the main thread and query workers.
 *
 * One pool of workers handles all query types (terrain, water, wind). Each
 * frame the main thread packs a batch of work items into the control SAB
 * and bumps a generation counter; workers wake via `Atomics.wait`, each
 * processes its assigned slice of the batch, and decrements a "remaining"
 * counter. The main thread polls the counter next frame and — once it
 * hits zero — reads results from the per-query-type SABs.
 *
 * Only zero-copy typed arrays flow across the boundary; no serialization.
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

/**
 * Control SAB layout (Int32Array view).
 *
 * The control block is small (one SAB for the whole pool). It carries
 * per-frame metadata plus synchronization primitives.
 */

/** Generation counter. Bumped by main thread each frame to signal work. */
export const CTRL_GENERATION = 0;

/**
 * Remaining workers that haven't finished the current generation's work.
 * Starts at `workerCount` when main thread submits, decremented atomically
 * by each worker as it finishes. Reaches zero when the frame is done.
 */
export const CTRL_REMAINING = 1;

/**
 * Number of distinct query types with work this frame. The first N entries
 * in the work-item list describe per-type batches.
 */
export const CTRL_NUM_TYPES = 2;

/** Reserved for future use (padding to 16-byte alignment). */
export const CTRL_RESERVED = 3;

/**
 * Start of the per-query-type descriptors. Each descriptor is 4 Int32
 * entries: [typeId, pointCount, stride, /* reserved * / 0].
 *
 * Up to 3 descriptors (one per query type) so the fixed-size control
 * block holds: 4 header ints + 3 * 4 descriptor ints = 16 ints = 64 bytes.
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
 * Init message sent once to each worker when it starts. Carries the SAB
 * handles the worker will use for its lifetime. Workers then enter a
 * wait-loop and never need another `postMessage`.
 */
export interface QueryWorkerInitMessage {
  type: "init";
  workerIndex: number;
  workerCount: number;
  controlSab: SharedArrayBuffer;
  /**
   * One entry per query type (index by `QueryTypeId`). Each entry holds
   * the points and results SABs for that query type. Stride for results
   * is carried in the per-frame descriptor.
   */
  channels: QueryWorkerChannel[];
}

export interface QueryWorkerChannel {
  pointsSab: SharedArrayBuffer;
  resultsSab: SharedArrayBuffer;
  /**
   * Small SAB carrying per-frame uniforms for this query type (time,
   * base wind, source weights, etc.). Sized generously so query types
   * don't have to negotiate layout with the pool — each query type
   * decides its own float layout.
   */
  paramsSab: SharedArrayBuffer;
  /**
   * Read-only per-query-type world state buffers. Ordering is
   * query-type-specific:
   *   - terrain: [packedTerrain]
   *   - water:   [packedWaveMesh, packedTideMesh]
   *   - wind:    [packedWindMesh]
   *
   * All packed-mesh builders allocate with SharedArrayBuffer, so handing
   * these views to workers is zero-copy even for large buffers (e.g. the
   * 500MB-class wave mesh on big maps).
   */
  worldState: readonly Uint32Array[];
  /**
   * SAB-backed frame-mutable state (e.g. water modifiers). Main thread
   * writes into it before each submit; workers see live updates.
   * Interpreted as a Float32Array by consumers.
   */
  frameStateSab: SharedArrayBuffer | null;
  /** Max points this channel's SABs are sized for. */
  maxPoints: number;
  /** Floats per result entry. */
  resultStride: number;
}

/**
 * Fixed size of each per-channel params SAB, in Float32 entries.
 *
 * Generous enough to hold scalar uniforms plus small inline tables:
 *   - wind: time, base velocity, 8 source weights, neutral defaults
 *   - water: time, tide, default depth, counts, tidal phase, plus up to
 *     8 wave sources × 8 floats = 64 floats inline.
 * Each query type carves out its own layout from this space.
 */
export const PARAMS_FLOATS_PER_CHANNEL = 128;

/** Sent to tell a worker to exit its loop and shut down. */
export interface QueryWorkerDestroyMessage {
  type: "destroy";
}

export type QueryWorkerMessage =
  | QueryWorkerInitMessage
  | QueryWorkerDestroyMessage;
