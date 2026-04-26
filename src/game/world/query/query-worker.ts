/**
 * Query worker entry point.
 *
 * Each worker instance owns:
 * - An index (0..workerCount-1) used to partition the per-frame work
 *   evenly across workers (round-robin-ish slicing).
 * - Float32Array views over a slice of the pool's shared
 *   `WebAssembly.Memory`, one view per channel buffer
 *   (points / params / results / modifiers / per-type packed world state).
 * - When `cpuEngine === "wasm"`, a private `WebAssembly.Instance` of the
 *   query-wasm module instantiated against the same shared memory.
 *   Per-instance state (the `set_packed_*` pointer table) is populated
 *   once at init.
 *
 * Main loop: wait-dispatch-decrement on the control SAB. Each frame:
 *   1. `Atomics.wait` until main bumps the generation counter.
 *   2. Read descriptors (which query types have points, how many).
 *   3. For each descriptor, compute this worker's slice and dispatch to
 *      the per-type handler — JS-CPU (`*-math.ts`) or wasm
 *      (`process_*_batch` with pointer arithmetic into shared memory).
 *   4. Atomically decrement `remaining`; the last worker wakes main.
 */

import {
  CTRL_DESCRIPTORS_BASE,
  CTRL_DESCRIPTOR_POINT_COUNT,
  CTRL_DESCRIPTOR_STRIDE,
  CTRL_DESCRIPTOR_STRIDE_FIELD,
  CTRL_DESCRIPTOR_TYPE_ID,
  CTRL_GENERATION,
  CTRL_NUM_TYPES,
  CTRL_REMAINING,
  PARAMS_FLOATS_PER_CHANNEL,
  QUERY_TYPE_TERRAIN,
  QUERY_TYPE_WATER,
  QUERY_TYPE_WIND,
  STRIDE_PER_POINT,
  TIMINGS_FLOATS_PER_WORKER,
  type QueryTypeId,
  type QueryWorkerMessage,
  type WasmChannelLayout,
} from "./query-worker-protocol";
import type { CpuQueryEngine } from "./QueryBackendState";
import { writeTerrainResult } from "./terrain-math";
import {
  TERRAIN_PARAM_CONTOUR_COUNT,
  TERRAIN_PARAM_DEFAULT_DEPTH,
} from "./terrain-params";
import { writeWaterResult } from "./water-math";
import {
  WATER_PARAM_CONTOUR_COUNT,
  WATER_PARAM_DEFAULT_DEPTH,
  WATER_PARAM_MODIFIER_COUNT,
  WATER_PARAM_NUM_WAVES,
  WATER_PARAM_TIDAL_PHASE,
  WATER_PARAM_TIDAL_STRENGTH,
  WATER_PARAM_TIDE_HEIGHT,
  WATER_PARAM_TIME,
  WATER_PARAM_WAVE_SOURCES_BASE,
} from "./water-params";
import { writeWindResult } from "./wind-math";
import { lookupWindMeshBlended } from "./wind-mesh-math";
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

interface ChannelView {
  points: Float32Array;
  results: Float32Array;
  params: Float32Array;
  frameState: Float32Array | null;
  /** Per-buffer Uint32 views for each packed world-state blob this type needs. */
  worldState: readonly Uint32Array[];
  resultStride: number;
  /** Byte offsets, used by the wasm dispatch path. */
  layout: WasmChannelLayout;
}

/**
 * Subset of the wasm `Instance.exports` we actually call. Each export
 * is a thin C-ABI shim into `pipeline/query-wasm/src/lib.rs`.
 */
interface WasmExports {
  query_implementation_mask(): number;
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

const WASM_IMPL_BIT_TERRAIN = 1 << 0;
const WASM_IMPL_BIT_WATER = 1 << 1;
const WASM_IMPL_BIT_WIND = 1 << 2;

let workerIndex = 0;
let workerCount = 1;
let control: Int32Array | null = null;
let channels: ChannelView[] = [];
let running = false;

/**
 * Engine selector. Workers always *can* execute via the JS path. When
 * `cpuEngine === "wasm"` and `wasmExports` is set, per-type dispatch
 * routes through the wasm kernel for any type whose
 * `query_implementation_mask` bit is set.
 */
let cpuEngine: CpuQueryEngine = "js";
let wasmExports: WasmExports | null = null;
let wasmImplementationMask = 0;

let timings: Float32Array | null = null;
let timingsBase = 0;

self.onmessage = (event: MessageEvent<QueryWorkerMessage>) => {
  const msg = event.data;
  if (msg.type === "init") {
    workerIndex = msg.workerIndex;
    workerCount = msg.workerCount;
    control = new Int32Array(msg.controlSab);
    timings = new Float32Array(msg.timingsSab);
    timingsBase = workerIndex * TIMINGS_FLOATS_PER_WORKER;
    cpuEngine = msg.cpuEngine;

    const buffer = msg.wasmMemory.buffer;
    channels = [
      buildChannelView(buffer, msg.partition.terrain),
      buildChannelView(buffer, msg.partition.water),
      buildChannelView(buffer, msg.partition.wind),
    ];

    // Instantiate the wasm module against the shared memory. Even when
    // `cpuEngine === "js"`, instantiation is cheap and harmless — we
    // just won't call into the kernel.
    instantiateWasm(msg.wasmModule, msg.wasmMemory).catch((err) => {
      console.error(
        `[query-worker ${workerIndex}] failed to instantiate wasm — falling back to JS for all types`,
        err,
      );
    });

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
  const points = new Float32Array(
    buffer,
    layout.pointsPtr,
    layout.maxPoints * STRIDE_PER_POINT,
  );
  const results = new Float32Array(
    buffer,
    layout.resultsPtr,
    layout.maxPoints * layout.resultStride,
  );
  const params = new Float32Array(
    buffer,
    layout.paramsPtr,
    PARAMS_FLOATS_PER_CHANNEL,
  );
  const frameState =
    layout.modifiersPtr !== 0 && layout.modifiersBytes > 0
      ? new Float32Array(
          buffer,
          layout.modifiersPtr,
          layout.modifiersBytes / Float32Array.BYTES_PER_ELEMENT,
        )
      : null;
  const worldState: Uint32Array[] = [];
  for (let i = 0; i < layout.worldStatePtrs.length; i++) {
    worldState.push(
      new Uint32Array(
        buffer,
        layout.worldStatePtrs[i],
        layout.worldStateLens[i],
      ),
    );
  }
  return {
    points,
    results,
    params,
    frameState,
    worldState,
    resultStride: layout.resultStride,
    layout,
  };
}

async function instantiateWasm(
  module: WebAssembly.Module,
  memory: WebAssembly.Memory,
): Promise<void> {
  const instance = await WebAssembly.instantiate(module, {
    env: { memory },
  });
  const exports = instance.exports as unknown as WasmExports;

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

  wasmImplementationMask = exports.query_implementation_mask();
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

    try {
      processFrame();
    } catch (err) {
      console.error("[query-worker] processFrame threw:", err);
    }

    const prev = Atomics.sub(control, CTRL_REMAINING, 1);
    if (prev === 1) {
      Atomics.notify(control, CTRL_REMAINING, 1);
    }
  }
}

function processFrame(): void {
  if (!control) return;
  if (timings) {
    for (let t = 0; t < TIMINGS_FLOATS_PER_WORKER; t++) {
      timings[timingsBase + t] = 0;
    }
  }
  const numTypes = Atomics.load(control, CTRL_NUM_TYPES);
  for (let i = 0; i < numTypes; i++) {
    const base = CTRL_DESCRIPTORS_BASE + i * CTRL_DESCRIPTOR_STRIDE;
    const typeId = control[base + CTRL_DESCRIPTOR_TYPE_ID] as QueryTypeId;
    const pointCount = control[base + CTRL_DESCRIPTOR_POINT_COUNT];
    const resultStride = control[base + CTRL_DESCRIPTOR_STRIDE_FIELD];
    if (pointCount === 0) continue;

    const [startPoint, endPoint] = sliceForWorker(pointCount);
    if (startPoint >= endPoint) continue;

    const dispatchStart = performance.now();
    dispatchQuery(typeId, channels, resultStride, startPoint, endPoint);
    if (timings) {
      timings[timingsBase + typeId] = performance.now() - dispatchStart;
    }
  }
}

function sliceForWorker(total: number): [number, number] {
  const base = Math.floor(total / workerCount);
  const residual = total - base * workerCount;
  const start = base * workerIndex + Math.min(workerIndex, residual);
  const mine = base + (workerIndex < residual ? 1 : 0);
  return [start, start + mine];
}

function implementsWasm(typeId: QueryTypeId): boolean {
  const bit =
    typeId === QUERY_TYPE_TERRAIN
      ? WASM_IMPL_BIT_TERRAIN
      : typeId === QUERY_TYPE_WATER
        ? WASM_IMPL_BIT_WATER
        : WASM_IMPL_BIT_WIND;
  return (wasmImplementationMask & bit) !== 0;
}

function dispatchQuery(
  typeId: QueryTypeId,
  channels: ChannelView[],
  resultStride: number,
  startPoint: number,
  endPoint: number,
): void {
  if (cpuEngine === "wasm" && wasmExports && implementsWasm(typeId)) {
    dispatchWasm(typeId, channels, resultStride, startPoint, endPoint);
    return;
  }

  const channel = channels[typeId];
  switch (typeId) {
    case QUERY_TYPE_TERRAIN:
      runTerrainQuery(
        channel.points,
        channel.results,
        channel.params,
        channel.worldState[0] ?? null,
        resultStride,
        startPoint,
        endPoint,
      );
      break;
    case QUERY_TYPE_WATER:
      runWaterQuery(channel, channels, resultStride, startPoint, endPoint);
      break;
    case QUERY_TYPE_WIND:
      runWindQuery(
        channel.points,
        channel.results,
        channel.params,
        channel.worldState[0] ?? null,
        resultStride,
        startPoint,
        endPoint,
      );
      break;
  }
}

/**
 * Wasm dispatch — pointer arithmetic into shared memory, no copies.
 *
 * The wasm function reads from `pointsPtr + sliceStart * stride` and
 * writes to `resultsPtr + sliceStart * resultStride`, exactly matching
 * the same Float32Array views the JS dispatch path uses. World-state
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

function zeroResultSlice(
  results: Float32Array,
  resultStride: number,
  startPoint: number,
  endPoint: number,
): void {
  const floatStart = startPoint * resultStride;
  const floatEnd = endPoint * resultStride;
  for (let i = floatStart; i < floatEnd; i++) {
    results[i] = 0;
  }
}

const _emptyModifiers = new Float32Array(0);
const _emptyWaveMesh = new Uint32Array(0);
const _emptyTerrain = new Uint32Array(0);
const _emptyTideMesh = new Uint32Array(0);

function runWaterQuery(
  channel: ChannelView,
  channels: ChannelView[],
  resultStride: number,
  startPoint: number,
  endPoint: number,
): void {
  const params = channel.params;
  const time = params[WATER_PARAM_TIME];
  const tideHeight = params[WATER_PARAM_TIDE_HEIGHT];
  const defaultDepth = params[WATER_PARAM_DEFAULT_DEPTH];
  const numWaves = params[WATER_PARAM_NUM_WAVES];
  const tidalPhase = params[WATER_PARAM_TIDAL_PHASE];
  const tidalStrength = params[WATER_PARAM_TIDAL_STRENGTH];
  const modifierCount = params[WATER_PARAM_MODIFIER_COUNT] | 0;

  const waveSources = params.subarray(WATER_PARAM_WAVE_SOURCES_BASE);

  const modifiers = channel.frameState ?? _emptyModifiers;
  const packedWaveMesh = channel.worldState[0] ?? _emptyWaveMesh;
  const packedTideMesh = channel.worldState[1] ?? _emptyTideMesh;
  const packedTerrain =
    channels[QUERY_TYPE_TERRAIN].worldState[0] ?? _emptyTerrain;

  const points = channel.points;
  const results = channel.results;
  for (let i = startPoint; i < endPoint; i++) {
    const worldX = points[i * STRIDE_PER_POINT];
    const worldY = points[i * STRIDE_PER_POINT + 1];
    writeWaterResult(
      worldX,
      worldY,
      time,
      tideHeight,
      defaultDepth,
      numWaves,
      tidalPhase,
      tidalStrength,
      packedTerrain,
      packedWaveMesh,
      packedTideMesh,
      modifiers,
      modifierCount,
      waveSources,
      results,
      i * resultStride,
    );
  }
}

function runTerrainQuery(
  points: Float32Array,
  results: Float32Array,
  params: Float32Array,
  worldState: Uint32Array | null,
  resultStride: number,
  startPoint: number,
  endPoint: number,
): void {
  if (!worldState) {
    zeroResultSlice(results, resultStride, startPoint, endPoint);
    return;
  }
  const contourCount = params[TERRAIN_PARAM_CONTOUR_COUNT];
  const defaultDepth = params[TERRAIN_PARAM_DEFAULT_DEPTH];

  for (let i = startPoint; i < endPoint; i++) {
    const worldX = points[i * STRIDE_PER_POINT];
    const worldY = points[i * STRIDE_PER_POINT + 1];
    writeTerrainResult(
      worldX,
      worldY,
      worldState,
      contourCount,
      defaultDepth,
      results,
      i * resultStride,
    );
  }
}

const _windMeshOut = new Float64Array(4);
const _windWeights = new Float32Array(WIND_PARAM_WEIGHTS_COUNT);

function runWindQuery(
  points: Float32Array,
  results: Float32Array,
  params: Float32Array,
  worldState: Uint32Array | null,
  resultStride: number,
  startPoint: number,
  endPoint: number,
): void {
  const time = params[WIND_PARAM_TIME];
  const baseX = params[WIND_PARAM_BASE_X];
  const baseY = params[WIND_PARAM_BASE_Y];
  const fallbackSpeed = params[WIND_PARAM_INFLUENCE_SPEED_FACTOR];
  const fallbackDir = params[WIND_PARAM_INFLUENCE_DIRECTION_OFFSET];
  const fallbackTurb = params[WIND_PARAM_INFLUENCE_TURBULENCE];

  for (let i = 0; i < WIND_PARAM_WEIGHTS_COUNT; i++) {
    _windWeights[i] = params[WIND_PARAM_WEIGHTS_BASE + i];
  }

  for (let i = startPoint; i < endPoint; i++) {
    const worldX = points[i * STRIDE_PER_POINT];
    const worldY = points[i * STRIDE_PER_POINT + 1];

    let speedFactor = fallbackSpeed;
    let dirOffset = fallbackDir;
    let turb = fallbackTurb;

    if (worldState && worldState.length > 0) {
      lookupWindMeshBlended(
        worldX,
        worldY,
        worldState,
        _windWeights,
        _windMeshOut,
      );
      if (_windMeshOut[3] > 0) {
        speedFactor = _windMeshOut[0];
        dirOffset = _windMeshOut[1];
        turb = _windMeshOut[2];
      }
    }

    writeWindResult(
      worldX,
      worldY,
      time,
      baseX,
      baseY,
      speedFactor,
      dirOffset,
      turb,
      results,
      i * resultStride,
    );
  }
}
