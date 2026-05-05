/**
 * Query worker entry point.
 *
 * Each worker instance owns:
 * - An index (0..workerCount-1) used to claim chunks from the pool's
 *   shared work-stealing counter.
 * - A private `WebAssembly.Instance` of the query-wasm module
 *   instantiated against the pool's shared memory. Per-instance state
 *   (the `set_packed_*` pointer table, this worker's shadow stack
 *   slot) is populated once at init.
 *
 * Main loop: wait-dispatch-decrement on the control SAB. Each frame:
 *   1. `Atomics.wait` until main bumps the generation counter.
 *   2. Read descriptors (which query types have points, how many).
 *   3. For each descriptor, claim chunks of points and dispatch to
 *      `process_*_batch` with pointer arithmetic into shared memory.
 *   4. Atomically decrement `remaining`; the last worker wakes main.
 */

import {
  BARRIER_TIMING_CALIBRATION_MS,
  BARRIER_TIMING_COMPUTE_END,
  BARRIER_TIMING_COMPUTE_START,
  BARRIER_TIMING_DECREMENT,
  BARRIER_TIMING_TYPE_FIRST_START_BASE,
  BARRIER_TIMING_TYPE_LAST_END_BASE,
  BARRIER_TIMING_WAKE,
  BARRIER_TIMINGS_PER_WORKER,
  CALIBRATION_PROBE_ITERATIONS,
  CHUNK_SIZE,
  MAX_DESCRIPTORS,
  CTRL_DESCRIPTORS_BASE,
  CTRL_DESCRIPTOR_POINT_COUNT,
  CTRL_DESCRIPTOR_STRIDE,
  CTRL_DESCRIPTOR_STRIDE_FIELD,
  CTRL_DESCRIPTOR_TYPE_ID,
  CTRL_GENERATION,
  CTRL_NEXT_CHUNK_BASE,
  CTRL_NUM_TYPES,
  CTRL_REMAINING,
  QUERY_TYPE_TERRAIN,
  QUERY_TYPE_WATER,
  QUERY_TYPE_WIND,
  STRIDE_PER_POINT,
  TIMINGS_FLOATS_PER_WORKER,
  type QueryTypeId,
  type QueryWorkerMessage,
  type WasmChannelLayout,
} from "./query-worker-protocol";
import { WATER_PARAM_MODIFIER_COUNT } from "./water-params";

/**
 * Subset of the wasm `Instance.exports` we actually call. Each export
 * is a thin C-ABI shim into `pipeline/query-wasm/src/lib.rs`.
 */
interface WasmExports {
  /**
   * Per-Instance shadow-stack pointer (mutable i32 global). We rewrite
   * this at init so each worker's stack lives in its own slot of the
   * shared linear memory rather than overlapping at the linker default.
   * Exported via the `--export=__stack_pointer` linker flag.
   */
  __stack_pointer: WebAssembly.Global;
  /** See `calibration_probe` in `pipeline/query-wasm/src/lib.rs`. */
  calibration_probe(iterations: number): number;
  set_packed_terrain(ptr: number, lenU32: number): void;
  set_packed_wave_mesh(ptr: number, lenU32: number): void;
  set_packed_tide_mesh(ptr: number, lenU32: number): void;
  set_packed_wind_mesh(ptr: number, lenU32: number): void;
  process_water_batch(
    pointsPtr: number,
    pointCount: number,
    paramsPtr: number,
    modifiersPtr: number,
    modifierCount: number,
    resultsPtr: number,
    resultStride: number,
  ): void;
  process_terrain_batch(
    pointsPtr: number,
    pointCount: number,
    paramsPtr: number,
    resultsPtr: number,
    resultStride: number,
  ): void;
  process_wind_batch(
    pointsPtr: number,
    pointCount: number,
    paramsPtr: number,
    resultsPtr: number,
    resultStride: number,
  ): void;
}

interface ChannelView {
  params: Float32Array;
  resultStride: number;
  layout: WasmChannelLayout;
}

let workerIndex = 0;
let workerCount = 1;
let control: Int32Array | null = null;
let channels: ChannelView[] = [];
let running = false;

let wasmExports: WasmExports | null = null;

let timings: Float32Array | null = null;
let timingsBase = 0;

let barrierTimings: Float64Array | null = null;
let barrierTimingsBase = 0;
/**
 * Constant offset (ms) added to every `performance.now()` we record into
 * the barrier-timings SAB. Set once at init so worker timestamps land on
 * the main thread's clock and can be diffed with main's `performance.now()`.
 */
let timeOriginOffset = 0;
function nowOnMainClock(): number {
  return performance.now() + timeOriginOffset;
}

self.onmessage = async (event: MessageEvent<QueryWorkerMessage>) => {
  const msg = event.data;
  if (msg.type === "init") {
    workerIndex = msg.workerIndex;
    workerCount = msg.workerCount;
    control = new Int32Array(msg.controlSab);
    timings = new Float32Array(msg.timingsSab);
    timingsBase = workerIndex * TIMINGS_FLOATS_PER_WORKER;
    barrierTimings = new Float64Array(msg.barrierTimingsSab);
    barrierTimingsBase = workerIndex * BARRIER_TIMINGS_PER_WORKER;
    timeOriginOffset = performance.timeOrigin - msg.mainTimeOrigin;

    const buffer = msg.wasmMemory.buffer;
    channels = [
      buildChannelView(buffer, msg.partition.terrain),
      buildChannelView(buffer, msg.partition.water),
      buildChannelView(buffer, msg.partition.wind),
    ];

    // Must await before entering the main loop — see `instantiateWasm`.
    const stackTop = msg.partition.stackTops[workerIndex];
    await instantiateWasm(msg.wasmModule, msg.wasmMemory, stackTop);

    running = true;
    runMainLoop();
  } else if (msg.type === "destroy") {
    running = false;
  }
};

self.addEventListener("error", (ev) => {
  console.error("[query-worker] unhandled error:", ev.message, ev.error);
});

function buildChannelView(
  buffer: ArrayBuffer,
  layout: WasmChannelLayout,
): ChannelView {
  const params = new Float32Array(
    buffer,
    layout.paramsPtr,
    layout.paramsBytes / Float32Array.BYTES_PER_ELEMENT,
  );
  return {
    params,
    resultStride: layout.resultStride,
    layout,
  };
}

/**
 * Build this worker's `WebAssembly.Instance`, set up its private shadow
 * stack, and register packed-buffer offsets with the per-instance
 * `WORLD_STATE` table.
 *
 * **Caller must `await` this before entering `runMainLoop`.** The loop
 * blocks on `Atomics.wait`, which freezes the worker's JS event loop,
 * so the `WebAssembly.instantiate` Promise (and any other microtask)
 * cannot resolve until the loop yields.
 */
async function instantiateWasm(
  module: WebAssembly.Module,
  memory: WebAssembly.Memory,
  stackTop: number,
): Promise<void> {
  const instance = await WebAssembly.instantiate(module, {
    env: { memory },
  });
  const exports = instance.exports as unknown as WasmExports;

  // Move this Instance's shadow stack into its assigned slot. Without
  // this every worker's `__stack_pointer` starts at the linker default
  // (1 MiB) and they all push/pop in the same memory region — fine for
  // kernels whose locals fit in wasm registers, fatal for paths that
  // spill (e.g. analytical-IDW gradient closures).
  exports.__stack_pointer.value = stackTop;

  // Each Instance has its own per-instance global state (the static
  // mut WORLD_STATE in Rust). Register the packed-buffer offsets with
  // this worker's instance so its `process_*_batch` calls can locate
  // them in shared memory.
  const terrainLayout = channels[QUERY_TYPE_TERRAIN].layout;
  if (terrainLayout.worldStatePtrs.length >= 1) {
    exports.set_packed_terrain(
      terrainLayout.worldStatePtrs[0],
      terrainLayout.worldStateLens[0],
    );
  }
  const waterLayout = channels[QUERY_TYPE_WATER].layout;
  if (waterLayout.worldStatePtrs.length >= 1) {
    exports.set_packed_wave_mesh(
      waterLayout.worldStatePtrs[0],
      waterLayout.worldStateLens[0],
    );
  }
  if (waterLayout.worldStatePtrs.length >= 2) {
    exports.set_packed_tide_mesh(
      waterLayout.worldStatePtrs[1],
      waterLayout.worldStateLens[1],
    );
  }
  const windLayout = channels[QUERY_TYPE_WIND].layout;
  if (windLayout.worldStatePtrs.length >= 1) {
    exports.set_packed_wind_mesh(
      windLayout.worldStatePtrs[0],
      windLayout.worldStateLens[0],
    );
  }

  wasmExports = exports;
}

function runMainLoop(): void {
  if (!control) return;
  let lastGeneration = 0;

  while (running) {
    const waitResult = Atomics.wait(
      control,
      CTRL_GENERATION,
      lastGeneration,
      /* timeout */ 1000,
    );
    if (!running) return;
    if (waitResult === "timed-out") continue;

    const generation = Atomics.load(control, CTRL_GENERATION);
    if (generation === lastGeneration) continue;
    lastGeneration = generation;

    if (barrierTimings) {
      barrierTimings[barrierTimingsBase + BARRIER_TIMING_WAKE] =
        nowOnMainClock();
    }

    try {
      processFrame(generation);
    } catch (err) {
      console.error("[query-worker] processFrame threw:", err);
    }

    if (barrierTimings) {
      barrierTimings[barrierTimingsBase + BARRIER_TIMING_DECREMENT] =
        nowOnMainClock();
    }
    const prev = Atomics.sub(control, CTRL_REMAINING, 1);
    if (prev === 1) {
      Atomics.notify(control, CTRL_REMAINING, 1);
    }
  }
}

function processFrame(generation: number): void {
  if (!control) return;
  if (timings) {
    for (let t = 0; t < TIMINGS_FLOATS_PER_WORKER; t++) {
      timings[timingsBase + t] = 0;
    }
  }
  if (barrierTimings) {
    // Calibration probe — pure-compute, no memory access. Round-robin
    // across workers (one per frame) so the per-frame overhead is fixed
    // at ~20 µs regardless of `workerCount`. A 0 sample for this worker
    // means "wasn't this worker's turn"; the pool aggregates only the
    // worker that ran it.
    if (wasmExports && generation % workerCount === workerIndex) {
      const probeStart = performance.now();
      wasmExports.calibration_probe(CALIBRATION_PROBE_ITERATIONS);
      barrierTimings[barrierTimingsBase + BARRIER_TIMING_CALIBRATION_MS] =
        performance.now() - probeStart;
    } else {
      barrierTimings[barrierTimingsBase + BARRIER_TIMING_CALIBRATION_MS] = 0;
    }
    barrierTimings[barrierTimingsBase + BARRIER_TIMING_COMPUTE_START] =
      nowOnMainClock();
    // Sentinel 0 = "didn't touch this type this frame". Aggregator skips.
    for (let t = 0; t < MAX_DESCRIPTORS; t++) {
      barrierTimings[
        barrierTimingsBase + BARRIER_TIMING_TYPE_FIRST_START_BASE + t
      ] = 0;
      barrierTimings[
        barrierTimingsBase + BARRIER_TIMING_TYPE_LAST_END_BASE + t
      ] = 0;
    }
  }
  const numTypes = Atomics.load(control, CTRL_NUM_TYPES);
  for (let i = 0; i < numTypes; i++) {
    const base = CTRL_DESCRIPTORS_BASE + i * CTRL_DESCRIPTOR_STRIDE;
    const typeId = control[base + CTRL_DESCRIPTOR_TYPE_ID] as QueryTypeId;
    const pointCount = control[base + CTRL_DESCRIPTOR_POINT_COUNT];
    const resultStride = control[base + CTRL_DESCRIPTOR_STRIDE_FIELD];
    if (pointCount === 0) continue;

    // Dynamic work-stealing: every worker races on the same atomic
    // counter, claims a chunk, processes it, and goes back for more.
    // Fast workers absorb more chunks than slow ones automatically.
    let elapsedMs = 0;
    let firstChunk = true;
    while (true) {
      const chunkIdx = Atomics.add(control, CTRL_NEXT_CHUNK_BASE + i, 1);
      const startPoint = chunkIdx * CHUNK_SIZE;
      if (startPoint >= pointCount) break;
      const endPoint = Math.min(startPoint + CHUNK_SIZE, pointCount);

      const dispatchStart = performance.now();
      if (barrierTimings && firstChunk) {
        barrierTimings[
          barrierTimingsBase + BARRIER_TIMING_TYPE_FIRST_START_BASE + typeId
        ] = nowOnMainClock();
        firstChunk = false;
      }
      dispatchWasm(typeId, channels, resultStride, startPoint, endPoint);
      const dispatchEndPerf = performance.now();
      elapsedMs += dispatchEndPerf - dispatchStart;
      if (barrierTimings) {
        barrierTimings[
          barrierTimingsBase + BARRIER_TIMING_TYPE_LAST_END_BASE + typeId
        ] = nowOnMainClock();
      }
    }
    if (timings && elapsedMs > 0) {
      timings[timingsBase + typeId] = elapsedMs;
    }
  }
  if (barrierTimings) {
    barrierTimings[barrierTimingsBase + BARRIER_TIMING_COMPUTE_END] =
      nowOnMainClock();
  }
}

/**
 * Wasm dispatch — pointer arithmetic into shared memory, no copies.
 *
 * The wasm function reads from `pointsPtr + sliceStart * stride` and
 * writes to `resultsPtr + sliceStart * resultStride`. World-state
 * pointers were uploaded via `set_packed_*` at worker init.
 */
function dispatchWasm(
  typeId: QueryTypeId,
  channels: ChannelView[],
  resultStride: number,
  startPoint: number,
  endPoint: number,
): void {
  if (!wasmExports) return;
  const channel = channels[typeId];
  const sliceCount = endPoint - startPoint;
  const layout = channel.layout;

  const pointsPtr =
    layout.pointsPtr +
    startPoint * STRIDE_PER_POINT * Float32Array.BYTES_PER_ELEMENT;
  const resultsPtr =
    layout.resultsPtr +
    startPoint * resultStride * Float32Array.BYTES_PER_ELEMENT;

  switch (typeId) {
    case QUERY_TYPE_TERRAIN:
      wasmExports.process_terrain_batch(
        pointsPtr,
        sliceCount,
        layout.paramsPtr,
        resultsPtr,
        resultStride,
      );
      break;
    case QUERY_TYPE_WATER: {
      const modifierCount = channel.params[WATER_PARAM_MODIFIER_COUNT] | 0;
      wasmExports.process_water_batch(
        pointsPtr,
        sliceCount,
        layout.paramsPtr,
        layout.modifiersPtr,
        modifierCount,
        resultsPtr,
        resultStride,
      );
      break;
    }
    case QUERY_TYPE_WIND:
      wasmExports.process_wind_batch(
        pointsPtr,
        sliceCount,
        layout.paramsPtr,
        resultsPtr,
        resultStride,
      );
      break;
  }
}
