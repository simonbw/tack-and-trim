/**
 * SharedArrayBuffer protocol for cloth solver worker communication.
 * No engine dependencies — importable from both main thread and worker.
 */

// State machine constants (Int32 values)
export const CLOTH_IDLE = 0;
export const CLOTH_SOLVING = 1;
export const CLOTH_DONE = 2;

// SAB layout:
//   [0]       Int32: state (IDLE / SOLVING / DONE)
//   [4]       Int32: swap flag (0 or 1 — which position buffer is "front")
//   [8..INPUT_END) Float64: input region
//   [INPUT_END..] Float64: position buffer A, position buffer B, reaction forces

// Input region offsets (in Float64 indices, starting at byte 8)
const INPUT_F64_START = 1; // byte 8 = Float64 index 1
export const INPUT_DT = 0;
export const INPUT_SUBSTEPS = 1;
export const INPUT_ITERATIONS = 2;
export const INPUT_CONSTRAINT_DAMPING = 3;
export const INPUT_CLOTH_MASS = 4;
export const INPUT_HOIST_AMOUNT = 5;
export const INPUT_WIND_X = 6;
export const INPUT_WIND_Y = 7;
export const INPUT_LIFT_SCALE = 8;
export const INPUT_DRAG_SCALE = 9;
// Pin targets: tack(x,y,z), clew(x,y,z), head(x,y,z)
export const INPUT_TACK_X = 10;
export const INPUT_TACK_Y = 11;
export const INPUT_TACK_Z = 12;
export const INPUT_CLEW_X = 13;
export const INPUT_CLEW_Y = 14;
export const INPUT_CLEW_Z = 15;
export const INPUT_HEAD_X = 16;
export const INPUT_HEAD_Y = 17;
export const INPUT_HEAD_Z = 18;
export const INPUT_CLEW_PINNED = 19;
export const INPUT_COUNT = 20;

// Output region: 9 reaction-force floats plus 1 solve-time float = 10 floats
export const REACTION_TACK_X = 0;
export const REACTION_TACK_Y = 1;
export const REACTION_TACK_Z = 2;
export const REACTION_HEAD_X = 3;
export const REACTION_HEAD_Y = 4;
export const REACTION_HEAD_Z = 5;
export const REACTION_CLEW_X = 6;
export const REACTION_CLEW_Y = 7;
export const REACTION_CLEW_Z = 8;
// Worker-measured wall-clock time spent in the solve, in milliseconds.
// Used to surface true worker CPU cost on the main thread (since waiting
// on the worker via Atomics only reveals latency, not compute time).
export const OUTPUT_SOLVE_MS = 9;
export const REACTION_COUNT = 10;

/**
 * Compute SAB byte size and region offsets for a given vertex count.
 */
export function computeLayout(vertexCount: number) {
  // Control: 2 Int32 values = 8 bytes (state + swap flag)
  const controlBytes = 8;
  // Input region: INPUT_COUNT Float64 values
  const inputBytes = INPUT_COUNT * 8;
  // Position buffer: vertexCount * 3 (x, y, z) Float64 values each
  const posBufferBytes = vertexCount * 3 * 8;
  // Reaction forces: REACTION_COUNT Float64 values
  const reactionBytes = REACTION_COUNT * 8;

  const inputByteOffset = controlBytes;
  const posAByteOffset = inputByteOffset + inputBytes;
  const posBByteOffset = posAByteOffset + posBufferBytes;
  const reactionByteOffset = posBByteOffset + posBufferBytes;
  const totalBytes = reactionByteOffset + reactionBytes;

  return {
    totalBytes,
    controlByteOffset: 0,
    inputByteOffset,
    posAByteOffset,
    posBByteOffset,
    reactionByteOffset,
    vertexCount,
  };
}

export type SABLayout = ReturnType<typeof computeLayout>;

/** Create the SharedArrayBuffer for a given vertex count. */
export function createSharedBuffer(vertexCount: number): SharedArrayBuffer {
  const layout = computeLayout(vertexCount);
  return new SharedArrayBuffer(layout.totalBytes);
}

/** Get Int32 view over the control region (state + swap flag). */
export function getControlView(sab: SharedArrayBuffer): Int32Array {
  return new Int32Array(sab, 0, 2);
}

/** Get Float64 view over the input region. */
export function getInputView(sab: SharedArrayBuffer): Float64Array {
  return new Float64Array(sab, 8, INPUT_COUNT);
}

/** Get Float64 view over position buffer A. */
export function getPositionsA(
  sab: SharedArrayBuffer,
  vertexCount: number,
): Float64Array {
  const layout = computeLayout(vertexCount);
  return new Float64Array(sab, layout.posAByteOffset, vertexCount * 3);
}

/** Get Float64 view over position buffer B. */
export function getPositionsB(
  sab: SharedArrayBuffer,
  vertexCount: number,
): Float64Array {
  const layout = computeLayout(vertexCount);
  return new Float64Array(sab, layout.posBByteOffset, vertexCount * 3);
}

/** Get Float64 view over reaction forces. */
export function getReactionForces(
  sab: SharedArrayBuffer,
  vertexCount: number,
): Float64Array {
  const layout = computeLayout(vertexCount);
  return new Float64Array(sab, layout.reactionByteOffset, REACTION_COUNT);
}

// ---- Message types ----

/** Furl mode determines how partial deployment is handled:
 * - "v-cutoff": mainsail in-boom roller — vertices above v threshold are excluded
 * - "u-wrap": jib forestay roller — vertices below u threshold are pinned to forestay
 */
export type FurlMode = "v-cutoff" | "u-wrap";

export interface ClothInitMessage {
  type: "init";
  sab: SharedArrayBuffer;
  vertexCount: number;
  indices: number[];
  // Solver snapshot (transferable arrays)
  positions: Float64Array;
  prevPositions: Float64Array;
  pinned: Uint8Array;
  pinTargets: Float64Array;
  skipped: Uint8Array;
  structA: Int32Array;
  structB: Int32Array;
  structRest: Float64Array;
  shearA: Int32Array;
  shearB: Int32Array;
  shearRest: Float64Array;
  bendA: Int32Array;
  bendB: Int32Array;
  bendRest: Float64Array;
  damping: number;
  bendStiffness: number;
  constraintDamping: number;
  // Pin vertex indices
  tackIdx: number;
  clewIdx: number;
  headIdx: number;
  // Mesh topology for furling
  luffVertices: number[];
  vertexU: Float64Array;
  vertexV: Float64Array;
  vertexChordFrac: Float64Array;
  furlMode: FurlMode;
}

export interface ClothDestroyMessage {
  type: "destroy";
}

export type ClothWorkerMessage = ClothInitMessage | ClothDestroyMessage;
