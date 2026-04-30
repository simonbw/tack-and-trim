/**
 * Microbenchmark worker — tight-loop driver for `process_*_batch`
 * (WASM) or the JS math ports.
 *
 * One worker per spawned thread. Lifecycle:
 *   1. Init: receive shared memory, optional precompiled wasm module,
 *      buffer-layout offsets, the worker's slice of the point set,
 *      the engine choice, and a small `barrierSab` for synchronisation
 *      with main thread.
 *   2. Worker instantiates the wasm module against the shared memory
 *      (if engine === "wasm") and registers world-state pointers via
 *      `set_packed_*`.
 *   3. Main loop: each round, wait on `BARRIER_GENERATION`, run N
 *      iterations of the hot path on its slice, record elapsed time
 *      into the timings region, and decrement `BARRIER_REMAINING`.
 *      The last worker to finish notifies main, which wakes from its
 *      `Atomics.waitAsync` and reads timings.
 *
 * Distinct from `query-worker.ts`: that one drives the production
 * worker pool through the SAB control protocol; this one is just a
 * timing harness for the kernels.
 */

import { writeTerrainResult } from "./terrain-math";
import { writeWaterResult } from "./water-math";
import { writeWindResult } from "./wind-math";
import { lookupWindMeshBlended } from "./wind-mesh-math";
import {
  PARAMS_FLOATS_PER_CHANNEL,
  STRIDE_PER_POINT,
} from "./query-worker-protocol";
import {
  WIND_PARAM_BASE_X,
  WIND_PARAM_BASE_Y,
  WIND_PARAM_INFLUENCE_DIRECTION_OFFSET,
  WIND_PARAM_INFLUENCE_SPEED_FACTOR,
  WIND_PARAM_INFLUENCE_TURBULENCE,
  WIND_PARAM_TIME,
  WIND_PARAM_WEIGHTS_BASE,
  WIND_PARAM_WEIGHTS_COUNT,
} from "./wind-params";
import {
  WATER_PARAM_CONTOUR_COUNT,
  WATER_PARAM_DEFAULT_DEPTH,
  WATER_PARAM_MODIFIER_COUNT,
  WATER_PARAM_NUM_WAVES,
  WATER_PARAM_TIDAL_PHASE,
  WATER_PARAM_TIDAL_STRENGTH,
  WATER_PARAM_TIDE_HEIGHT,
  WATER_PARAM_TIME,
  WATER_PARAM_WAVE_AMPLITUDE_SCALE,
  WATER_PARAM_WAVE_SOURCES_BASE,
} from "./water-params";

// ---------------------------------------------------------------------------
// Shared layout — main thread fills `BenchLayout` and ships it via init.
// ---------------------------------------------------------------------------

export interface BenchLayout {
  pointsPtr: number;
  paramsPtr: number;
  resultsPtr: number;
  modifiersPtr: number;
  packedTerrainPtr: number;
  packedTerrainLen: number;
  packedWaveMeshPtr: number;
  packedWaveMeshLen: number;
  packedTideMeshPtr: number;
  packedTideMeshLen: number;
  packedWindMeshPtr: number;
  packedWindMeshLen: number;
  pointCount: number;
  /**
   * Per-worker shadow-stack tops (byte addresses). Each Instance writes
   * its assigned slot into `__stack_pointer` at init so concurrent
   * workers don't smash each other's frames in the linker-default 1 MiB
   * stack region. See `STACK_BYTES_PER_WORKER` in
   * `query-worker-protocol.ts`.
   */
  stackTops: number[];
}

export type BenchEngine = "js" | "wasm";
export type BenchQueryType = "water" | "wind" | "terrain";

/**
 * Barrier SAB layout (Int32Array). Indexed as i32:
 *   [0] generation — main bumps to start each round; workers wait on it.
 *   [1] remaining  — set to workerCount each round; workers decrement.
 *   [2..N+1] per-worker f32 elapsed ms, viewed as Float32Array.
 */
const BARRIER_GENERATION = 0;
const BARRIER_REMAINING = 1;
export const BARRIER_TIMING_BASE = 2;

interface InitMessage {
  type: "init";
  workerIndex: number;
  workerCount: number;
  wasmMemory: WebAssembly.Memory;
  wasmModule: WebAssembly.Module;
  barrierSab: SharedArrayBuffer;
  layout: BenchLayout;
  sliceStart: number;
  sliceCount: number;
  engine: BenchEngine;
  queryType: BenchQueryType;
  iterations: number;
}

interface DestroyMessage {
  type: "destroy";
}

type WorkerMessage = InitMessage | DestroyMessage;

interface WasmKernelExports {
  /**
   * Per-Instance shadow-stack pointer. We write into this at init so
   * each bench worker's stack lives in its own slot of the shared linear
   * memory rather than overlapping at the linker default. Exported via
   * the `--export=__stack_pointer` linker flag.
   */
  __stack_pointer: WebAssembly.Global;
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

let running = false;

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const msg = event.data;
  if (msg.type === "destroy") {
    running = false;
    return;
  }
  if (msg.type !== "init") return;

  running = true;
  try {
    await runWorkerLoop(msg);
  } catch (err) {
    console.error("[bench-worker] fatal error:", err);
  }
};

self.addEventListener("error", (ev) => {
  console.error("[bench-worker] unhandled error:", ev.message, ev.error);
});

async function runWorkerLoop(init: InitMessage): Promise<void> {
  const buffer = init.wasmMemory.buffer;
  const barrier = new Int32Array(init.barrierSab);
  const timings = new Float32Array(
    init.barrierSab,
    BARRIER_TIMING_BASE * Int32Array.BYTES_PER_ELEMENT,
    init.workerCount,
  );

  const layout = init.layout;
  const sliceStart = init.sliceStart;
  const sliceCount = init.sliceCount;

  // Read modifierCount once from the params region. The harness writes
  // it as f32 at WATER_PARAM_MODIFIER_COUNT (= 7) and never mutates
  // params during the bench loop.
  const paramsView = new Float32Array(
    buffer,
    layout.paramsPtr,
    PARAMS_FLOATS_PER_CHANNEL,
  );
  const modifierCount = paramsView[WATER_PARAM_MODIFIER_COUNT] | 0;

  // Engine setup. WASM: instantiate against shared memory, register
  // packed-buffer pointers. JS: build typed-array views and helpers
  // matching what `query-worker.ts` does for production.
  let wasmExports: WasmKernelExports | null = null;
  let jsContext: JsBenchContext | null = null;
  if (init.engine === "wasm") {
    const instance = await WebAssembly.instantiate(init.wasmModule, {
      env: { memory: init.wasmMemory },
    });
    wasmExports = instance.exports as unknown as WasmKernelExports;
    // Move this Instance's shadow stack into its assigned slot. See
    // `STACK_BYTES_PER_WORKER` in `query-worker-protocol.ts` for the
    // why — without this, every Instance starts with the linker default
    // (`__stack_pointer = 1 MiB`) and concurrent workers smash each
    // other's frames.
    wasmExports.__stack_pointer.value = layout.stackTops[init.workerIndex];
    if (layout.packedTerrainLen > 0) {
      wasmExports.set_packed_terrain(
        layout.packedTerrainPtr,
        layout.packedTerrainLen,
      );
    }
    if (layout.packedWaveMeshLen > 0) {
      wasmExports.set_packed_wave_mesh(
        layout.packedWaveMeshPtr,
        layout.packedWaveMeshLen,
      );
    }
    if (layout.packedTideMeshLen > 0) {
      wasmExports.set_packed_tide_mesh(
        layout.packedTideMeshPtr,
        layout.packedTideMeshLen,
      );
    }
    if (layout.packedWindMeshLen > 0) {
      wasmExports.set_packed_wind_mesh(
        layout.packedWindMeshPtr,
        layout.packedWindMeshLen,
      );
    }
  } else {
    jsContext = buildJsContext(buffer, layout);
  }

  console.log(
    `[bench-worker] worker ${init.workerIndex}/${init.workerCount} ready (engine=${init.engine} type=${init.queryType} slice=[${sliceStart},${sliceStart + sliceCount}) iter=${init.iterations})`,
  );

  // Wake-up loop: each "round" is signalled by main bumping
  // BARRIER_GENERATION. Workers run their loop, write their elapsed
  // ms into `timings`, then decrement BARRIER_REMAINING.
  let lastGeneration = 0;
  while (running) {
    const r = Atomics.wait(barrier, BARRIER_GENERATION, lastGeneration, 5000);
    if (r === "timed-out") continue;
    if (!running) return;
    const generation = Atomics.load(barrier, BARRIER_GENERATION);
    if (generation === lastGeneration) continue;
    if (generation < 0) return; // main signalled shutdown
    lastGeneration = generation;

    const t0 = performance.now();
    if (wasmExports) {
      runWasmIterations(
        init.queryType,
        init.iterations,
        sliceStart,
        sliceCount,
        modifierCount,
        layout,
        wasmExports,
      );
    } else if (jsContext) {
      runJsIterations(
        init.queryType,
        init.iterations,
        sliceStart,
        sliceCount,
        modifierCount,
        jsContext,
      );
    }
    const elapsed = performance.now() - t0;
    timings[init.workerIndex] = elapsed;

    const prev = Atomics.sub(barrier, BARRIER_REMAINING, 1);
    if (prev === 1) {
      Atomics.notify(barrier, BARRIER_REMAINING, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Per-engine inner loops
// ---------------------------------------------------------------------------

interface JsContext_Common {
  pointsView: Float32Array;
  paramsView: Float32Array;
  resultsView: Float32Array;
  modifiersView: Float32Array;
  packedTerrain: Uint32Array;
  packedWaveMesh: Uint32Array;
  packedTideMesh: Uint32Array;
  packedWindMesh: Uint32Array | null;
}

interface JsBenchContext extends JsContext_Common {
  // Pre-extracted scalars from params for the bench loop. The bench
  // never changes params during the hot loop, so caching these
  // matches what production workers would see (params are stable
  // within a frame).
  windWeights: Float32Array;
  windMeshOut: Float64Array;
}

function buildJsContext(
  buffer: ArrayBuffer,
  layout: BenchLayout,
): JsBenchContext {
  const pointsView = new Float32Array(
    buffer,
    layout.pointsPtr,
    layout.pointCount * STRIDE_PER_POINT,
  );
  const paramsView = new Float32Array(
    buffer,
    layout.paramsPtr,
    PARAMS_FLOATS_PER_CHANNEL,
  );
  // Results buffer is sized for the largest result stride (water=6).
  const resultsView = new Float32Array(
    buffer,
    layout.resultsPtr,
    layout.pointCount * 6,
  );
  const modifiersView = new Float32Array(
    buffer,
    layout.modifiersPtr,
    16384 * 14,
  );
  const packedTerrain = new Uint32Array(
    buffer,
    layout.packedTerrainPtr,
    layout.packedTerrainLen,
  );
  const packedWaveMesh = new Uint32Array(
    buffer,
    layout.packedWaveMeshPtr,
    layout.packedWaveMeshLen,
  );
  const packedTideMesh = new Uint32Array(
    buffer,
    layout.packedTideMeshPtr,
    layout.packedTideMeshLen,
  );
  const packedWindMesh =
    layout.packedWindMeshLen > 0
      ? new Uint32Array(
          buffer,
          layout.packedWindMeshPtr,
          layout.packedWindMeshLen,
        )
      : null;
  return {
    pointsView,
    paramsView,
    resultsView,
    modifiersView,
    packedTerrain,
    packedWaveMesh,
    packedTideMesh,
    packedWindMesh,
    windWeights: new Float32Array(WIND_PARAM_WEIGHTS_COUNT),
    windMeshOut: new Float64Array(4),
  };
}

function runWasmIterations(
  queryType: BenchQueryType,
  iterations: number,
  sliceStart: number,
  sliceCount: number,
  modifierCount: number,
  layout: BenchLayout,
  exp: WasmKernelExports,
): void {
  const F32_BYTES = Float32Array.BYTES_PER_ELEMENT;
  const sliceStartByte =
    layout.pointsPtr + sliceStart * STRIDE_PER_POINT * F32_BYTES;
  if (queryType === "water") {
    const stride = 6;
    const resultsPtr = layout.resultsPtr + sliceStart * stride * F32_BYTES;
    for (let i = 0; i < iterations; i++) {
      exp.process_water_batch(
        sliceStartByte,
        sliceCount,
        layout.paramsPtr,
        layout.modifiersPtr,
        modifierCount,
        resultsPtr,
        stride,
      );
    }
  } else if (queryType === "terrain") {
    const stride = 4;
    const resultsPtr = layout.resultsPtr + sliceStart * stride * F32_BYTES;
    for (let i = 0; i < iterations; i++) {
      exp.process_terrain_batch(
        sliceStartByte,
        sliceCount,
        layout.paramsPtr,
        resultsPtr,
        stride,
      );
    }
  } else {
    const stride = 4;
    const resultsPtr = layout.resultsPtr + sliceStart * stride * F32_BYTES;
    for (let i = 0; i < iterations; i++) {
      exp.process_wind_batch(
        sliceStartByte,
        sliceCount,
        layout.paramsPtr,
        resultsPtr,
        stride,
      );
    }
  }
}

function runJsIterations(
  queryType: BenchQueryType,
  iterations: number,
  sliceStart: number,
  sliceCount: number,
  modifierCount: number,
  ctx: JsBenchContext,
): void {
  const sliceEnd = sliceStart + sliceCount;
  if (queryType === "water") {
    const stride = 6;
    const params = ctx.paramsView;
    const time = params[WATER_PARAM_TIME];
    const tideHeight = params[WATER_PARAM_TIDE_HEIGHT];
    const defaultDepth = params[WATER_PARAM_DEFAULT_DEPTH];
    const numWaves = params[WATER_PARAM_NUM_WAVES];
    const tidalPhase = params[WATER_PARAM_TIDAL_PHASE];
    const tidalStrength = params[WATER_PARAM_TIDAL_STRENGTH];
    const waveAmplitudeScale = params[WATER_PARAM_WAVE_AMPLITUDE_SCALE];
    // modifierCount is supplied by caller (read once at worker init).
    const waveSources = params.subarray(WATER_PARAM_WAVE_SOURCES_BASE);
    for (let it = 0; it < iterations; it++) {
      for (let i = sliceStart; i < sliceEnd; i++) {
        const x = ctx.pointsView[i * STRIDE_PER_POINT];
        const y = ctx.pointsView[i * STRIDE_PER_POINT + 1];
        writeWaterResult(
          x,
          y,
          time,
          tideHeight,
          defaultDepth,
          numWaves,
          tidalPhase,
          tidalStrength,
          waveAmplitudeScale,
          ctx.packedTerrain,
          ctx.packedWaveMesh,
          ctx.packedTideMesh,
          ctx.modifiersView,
          modifierCount,
          waveSources,
          ctx.resultsView,
          i * stride,
        );
      }
    }
  } else if (queryType === "terrain") {
    const stride = 4;
    const contourCount = params_terrainContourCount(ctx.paramsView);
    const defaultDepth = ctx.paramsView[1];
    for (let it = 0; it < iterations; it++) {
      for (let i = sliceStart; i < sliceEnd; i++) {
        const x = ctx.pointsView[i * STRIDE_PER_POINT];
        const y = ctx.pointsView[i * STRIDE_PER_POINT + 1];
        writeTerrainResult(
          x,
          y,
          ctx.packedTerrain,
          contourCount,
          defaultDepth,
          ctx.resultsView,
          i * stride,
        );
      }
    }
  } else {
    const stride = 4;
    const params = ctx.paramsView;
    const time = params[WIND_PARAM_TIME];
    const baseX = params[WIND_PARAM_BASE_X];
    const baseY = params[WIND_PARAM_BASE_Y];
    const fallbackSpeed = params[WIND_PARAM_INFLUENCE_SPEED_FACTOR];
    const fallbackDir = params[WIND_PARAM_INFLUENCE_DIRECTION_OFFSET];
    const fallbackTurb = params[WIND_PARAM_INFLUENCE_TURBULENCE];
    for (let i = 0; i < WIND_PARAM_WEIGHTS_COUNT; i++) {
      ctx.windWeights[i] = params[WIND_PARAM_WEIGHTS_BASE + i];
    }
    for (let it = 0; it < iterations; it++) {
      for (let i = sliceStart; i < sliceEnd; i++) {
        const x = ctx.pointsView[i * STRIDE_PER_POINT];
        const y = ctx.pointsView[i * STRIDE_PER_POINT + 1];
        let speedFactor = fallbackSpeed;
        let dirOffset = fallbackDir;
        let turb = fallbackTurb;
        if (ctx.packedWindMesh) {
          lookupWindMeshBlended(
            x,
            y,
            ctx.packedWindMesh,
            ctx.windWeights,
            ctx.windMeshOut,
          );
          if (ctx.windMeshOut[3] > 0) {
            speedFactor = ctx.windMeshOut[0];
            dirOffset = ctx.windMeshOut[1];
            turb = ctx.windMeshOut[2];
          }
        }
        writeWindResult(
          x,
          y,
          time,
          baseX,
          baseY,
          speedFactor,
          dirOffset,
          turb,
          ctx.resultsView,
          i * stride,
        );
      }
    }
  }
}

function params_terrainContourCount(params: Float32Array): number {
  // TERRAIN_PARAM_CONTOUR_COUNT in `terrain-params.ts` is f32 offset 0.
  return params[0] | 0;
}
