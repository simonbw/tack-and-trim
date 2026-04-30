/**
 * Multi-thread microbenchmark for the query kernels.
 *
 * Spawns N web workers (`bench-worker.ts`), each instantiating its
 * own `WebAssembly.Instance` against a single shared
 * `WebAssembly.Memory`. Workers process disjoint slices of a fixed
 * 1024-point set in tight loops; the main thread orchestrates rounds
 * via a small barrier `SharedArrayBuffer`.
 *
 * For each (queryType, engine, workerCount) cell:
 *   1. Spawn `workerCount` workers, each initialised with the same
 *      shared memory + wasm module + layout, plus its slice indices,
 *      engine, queryType, and per-round iteration count.
 *   2. Discard the first warmup trial result.
 *   3. Run TRIALS more rounds; each round, all workers wake on the
 *      barrier, run their iterations, write per-worker elapsed ms,
 *      and decrement `BARRIER_REMAINING`.
 *   4. Wall-clock for the round = max of per-worker times. Total
 *      points processed = pointCount × iterations. ns/point = wall
 *      × 1e6 / (pointCount × iterations).
 *   5. Tear down the workers; move to the next cell.
 *
 * Reports both per-engine ns/point and the parallel scaling curve.
 */

import type { Game } from "../../../core/Game";
import { V, type V2d } from "../../../core/Vector";
import { TerrainQueryManager } from "../terrain/TerrainQueryManager";
import { WaterQueryManager } from "../water/WaterQueryManager";
import { WindQueryManager } from "../wind/WindQueryManager";
import {
  PARAMS_FLOATS_PER_CHANNEL,
  STACK_BYTES_PER_WORKER,
  STRIDE_PER_POINT,
} from "./query-worker-protocol";
import {
  WATER_PARAM_CONTOUR_COUNT,
  WATER_PARAM_DEFAULT_DEPTH,
  WATER_PARAM_FLOATS_PER_WAVE,
  WATER_PARAM_MAX_WAVES,
  WATER_PARAM_MODIFIER_COUNT,
  WATER_PARAM_NUM_WAVES,
  WATER_PARAM_TIDAL_PHASE,
  WATER_PARAM_TIDAL_STRENGTH,
  WATER_PARAM_TIDE_HEIGHT,
  WATER_PARAM_TIME,
  WATER_PARAM_WAVE_SOURCES_BASE,
} from "./water-params";
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
  BARRIER_TIMING_BASE,
  type BenchEngine,
  type BenchLayout,
  type BenchQueryType,
} from "./bench-worker";

const POINT_COUNT = 1024;
const TRIALS = 5;
// Per-iteration cost varies by ~3 orders of magnitude across cells
// (san-juan water JS at ~100µs/pt × 1024 = ~100ms/iter vs wasm wind
// at ~0.5µs/pt × 1024 = ~0.5ms/iter). Pick a small fixed iteration
// count that gives meaningful (≥several ms) measurement on the fast
// cells without making slow cells take forever.
const ITERATIONS_PER_TRIAL = 10;

const FLOATS_PER_MODIFIER = 14;
const QUERY_TYPES: BenchQueryType[] = ["water", "wind", "terrain"];
const ENGINES: BenchEngine[] = ["js", "wasm"];

export interface PerCellStats {
  /** Wall-clock per round = max(per-worker elapsed). */
  meanWallClockMs: number;
  minWallClockMs: number;
  /** ns/point = wallClockMs * 1e6 / (pointCount * iterations). */
  meanNsPerPoint: number;
  minNsPerPoint: number;
}

export interface PerTypeReport {
  /** Indexed by workerCount → (js | wasm) → stats. */
  byWorkerCount: Record<number, Record<BenchEngine, PerCellStats>>;
}

export interface MicrobenchReport {
  hardwareConcurrency: number;
  workerCounts: number[];
  pointCount: number;
  iterationsPerTrial: number;
  trials: number;
  water: PerTypeReport;
  wind: PerTypeReport;
  terrain: PerTypeReport;
}

const BARRIER_GENERATION = 0;
const BARRIER_REMAINING = 1;

/**
 * Run the full multi-thread sweep. Requires the GPU backend to be
 * active so we can capture `lastCompletedDispatchParams` from each
 * query manager (used as the bench's input snapshot).
 */
export async function runQueryMicrobench(
  game: Game,
): Promise<MicrobenchReport> {
  const terrainMgr = game.entities.tryGetSingleton(TerrainQueryManager);
  const waterMgr = game.entities.tryGetSingleton(WaterQueryManager);
  const windMgr = game.entities.tryGetSingleton(WindQueryManager);
  if (!terrainMgr || !waterMgr || !windMgr) {
    throw new Error(
      "[QueryMicrobench] GPU managers not found — microbench requires the GPU backend.",
    );
  }
  const tSnap = terrainMgr.lastCompletedDispatchParams;
  const wSnap = waterMgr.lastCompletedDispatchParams;
  const windSnap = windMgr.lastCompletedDispatchParams;
  if (!tSnap || !wSnap || !windSnap) {
    throw new Error(
      "[QueryMicrobench] GPU dispatch snapshots not yet available — let the game run a few frames first.",
    );
  }

  const hardwareConcurrency =
    (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
  const workerCounts = pickWorkerCounts(hardwareConcurrency);

  // Compile wasm and probe heap base.
  const url = new URL("./generated/query.wasm", import.meta.url);
  const wasmModule = await WebAssembly.compileStreaming(fetch(url));
  const probeMemory = new WebAssembly.Memory({
    initial: 17,
    maximum: 17,
    shared: true,
  });
  const probe = await WebAssembly.instantiate(wasmModule, {
    env: { memory: probeMemory },
  });
  const heapBase = (probe.exports.__heap_base as WebAssembly.Global)
    .value as number;

  // Build a layout big enough for one shared region + world state.
  // Reused for every cell — workers in different cells receive the
  // same memory + offsets. Reserve enough per-worker shadow-stack
  // regions for the largest cell's worker count.
  const points = generateBenchPoints(POINT_COUNT);
  const maxWorkerCount = Math.max(...workerCounts);
  const layout = buildLayout(
    heapBase,
    points.length,
    {
      packedTerrain: tSnap.packedTerrain,
      packedWaveMesh: wSnap.packedWaveMesh,
      packedTideMesh: wSnap.packedTideMesh,
      packedWindMesh: windSnap.packedWindMesh,
    },
    maxWorkerCount,
  );
  const initialPages = Math.ceil(layout.totalBytes / 65536) + 16;
  const memory = new WebAssembly.Memory({
    initial: initialPages,
    maximum: 65536,
    shared: true,
  });

  // Copy world state into shared memory once.
  const buffer = memory.buffer;
  copyU32If(buffer, layout.packedTerrainPtr, tSnap.packedTerrain);
  copyU32If(buffer, layout.packedWaveMeshPtr, wSnap.packedWaveMesh);
  copyU32If(buffer, layout.packedTideMeshPtr, wSnap.packedTideMesh);
  copyU32If(buffer, layout.packedWindMeshPtr, windSnap.packedWindMesh);
  // Write the deterministic point set once.
  writePointsToBuf(buffer, layout.pointsPtr, points);

  // For each query type, write its params into the shared params
  // region. Bench workers cache them at init.
  const paramsByType: Record<BenchQueryType, Float32Array> = {
    water: buildWaterParams(wSnap),
    wind: buildWindParams(windSnap),
    terrain: buildTerrainParams(tSnap),
  };

  // Modifier table copy (water only). Bench workers read modifierCount
  // from params at init and re-use this region every round.
  if (wSnap.modifierCount > 0) {
    const floats = wSnap.modifierCount * FLOATS_PER_MODIFIER;
    const modsView = new Float32Array(
      buffer,
      layout.modifiersPtr,
      16384 * FLOATS_PER_MODIFIER,
    );
    modsView.set(
      wSnap.modifiers.subarray(0, Math.min(floats, modsView.length)),
    );
  }

  const water: PerTypeReport = { byWorkerCount: {} };
  const wind: PerTypeReport = { byWorkerCount: {} };
  const terrain: PerTypeReport = { byWorkerCount: {} };
  const reports: Record<BenchQueryType, PerTypeReport> = {
    water,
    wind,
    terrain,
  };

  for (const workerCount of workerCounts) {
    for (const engine of ENGINES) {
      for (const queryType of QUERY_TYPES) {
        console.log(
          `[QueryMicrobench] cell engine=${engine} type=${queryType} workerCount=${workerCount}`,
        );
        // Write the right params for this query type before workers
        // sample them at init.
        new Float32Array(
          buffer,
          layout.paramsPtr,
          PARAMS_FLOATS_PER_CHANNEL,
        ).set(paramsByType[queryType]);

        const stats = await runCell(
          memory,
          wasmModule,
          layout,
          engine,
          queryType,
          workerCount,
          points.length,
          ITERATIONS_PER_TRIAL,
        );
        if (!reports[queryType].byWorkerCount[workerCount]) {
          reports[queryType].byWorkerCount[workerCount] = {} as Record<
            BenchEngine,
            PerCellStats
          >;
        }
        reports[queryType].byWorkerCount[workerCount][engine] = stats;
      }
    }
  }

  return {
    hardwareConcurrency,
    workerCounts,
    pointCount: points.length,
    iterationsPerTrial: ITERATIONS_PER_TRIAL,
    trials: TRIALS,
    water,
    wind,
    terrain,
  };
}

// ---------------------------------------------------------------------------
// Per-cell driver
// ---------------------------------------------------------------------------

async function runCell(
  memory: WebAssembly.Memory,
  wasmModule: WebAssembly.Module,
  layout: BenchLayout,
  engine: BenchEngine,
  queryType: BenchQueryType,
  workerCount: number,
  pointCount: number,
  iterations: number,
): Promise<PerCellStats> {
  // Barrier: [generation, remaining, then per-worker f32 timings].
  const barrierSab = new SharedArrayBuffer(
    (BARRIER_TIMING_BASE + workerCount) * Int32Array.BYTES_PER_ELEMENT,
  );
  const barrier = new Int32Array(barrierSab);
  const timings = new Float32Array(
    barrierSab,
    BARRIER_TIMING_BASE * Int32Array.BYTES_PER_ELEMENT,
    workerCount,
  );

  const workers: Worker[] = [];
  for (let i = 0; i < workerCount; i++) {
    const w = new Worker(new URL("./bench-worker.ts", import.meta.url), {
      type: "module",
    });
    w.addEventListener("error", (ev) => {
      console.error(`[QueryMicrobench] worker ${i} error:`, ev.message);
    });
    workers.push(w);
  }

  const [sliceStarts, sliceCounts] = sliceForWorkers(pointCount, workerCount);
  for (let i = 0; i < workerCount; i++) {
    workers[i].postMessage({
      type: "init",
      workerIndex: i,
      workerCount,
      wasmMemory: memory,
      wasmModule,
      barrierSab,
      layout,
      sliceStart: sliceStarts[i],
      sliceCount: sliceCounts[i],
      engine,
      queryType,
      iterations,
    });
  }

  // Workers spend a few ms instantiating the wasm module + registering
  // packed-buffer pointers. Give them a moment to settle before the
  // first round. Without this the warmup round can include
  // instantiation cost.
  await new Promise((r) => setTimeout(r, 50));

  const wallClocksMs: number[] = [];
  for (let trial = 0; trial < TRIALS + 1; trial++) {
    // Reset remaining counter and bump generation to start the round.
    Atomics.store(barrier, BARRIER_REMAINING, workerCount);
    const newGen = trial + 1;
    Atomics.store(barrier, BARRIER_GENERATION, newGen);
    Atomics.notify(barrier, BARRIER_GENERATION, workerCount);

    // Wait for all workers to finish (BARRIER_REMAINING → 0). Bound
    // each waitAsync at 1s so a stuck worker surfaces as a clear
    // error instead of an opaque test timeout.
    const waitStart = performance.now();
    while (Atomics.load(barrier, BARRIER_REMAINING) !== 0) {
      const cur = Atomics.load(barrier, BARRIER_REMAINING);
      const { async, value } = Atomics.waitAsync(
        barrier,
        BARRIER_REMAINING,
        cur,
        1000,
      );
      if (async) await value;
      if (performance.now() - waitStart > 30000) {
        throw new Error(
          `[QueryMicrobench] cell stuck (engine=${engine} queryType=${queryType} workerCount=${workerCount} trial=${trial} remaining=${Atomics.load(barrier, BARRIER_REMAINING)})`,
        );
      }
    }

    // Wall clock = slowest worker.
    let wall = 0;
    for (let i = 0; i < workerCount; i++) {
      if (timings[i] > wall) wall = timings[i];
    }
    if (trial > 0) wallClocksMs.push(wall);
  }

  // Tear down workers.
  for (const w of workers) {
    w.postMessage({ type: "destroy" });
    w.terminate();
  }

  const minWall = Math.min(...wallClocksMs);
  const meanWall =
    wallClocksMs.reduce((a, b) => a + b, 0) / wallClocksMs.length;
  const totalPoints = pointCount * iterations;
  return {
    meanWallClockMs: meanWall,
    minWallClockMs: minWall,
    meanNsPerPoint: (meanWall * 1e6) / totalPoints,
    minNsPerPoint: (minWall * 1e6) / totalPoints,
  };
}

function sliceForWorkers(
  total: number,
  workerCount: number,
): [number[], number[]] {
  const base = Math.floor(total / workerCount);
  const residual = total - base * workerCount;
  const starts: number[] = [];
  const counts: number[] = [];
  for (let i = 0; i < workerCount; i++) {
    const start = base * i + Math.min(i, residual);
    const mine = base + (i < residual ? 1 : 0);
    starts.push(start);
    counts.push(mine);
  }
  return [starts, counts];
}

function pickWorkerCounts(hardwareConcurrency: number): number[] {
  const heuristicDefault = Math.max(hardwareConcurrency - 4, 2);
  // [1, 2, 4, default-heuristic] — 4 points on the scaling curve
  // covers single-thread, doubled, default-quad, and the production
  // setting. Including `hardwareConcurrency` makes the sweep run too
  // long on big maps; the heuristic value is what production uses.
  const counts = new Set<number>([1, 2, 4, heuristicDefault]);
  return [...counts].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Layout, points, params helpers
// ---------------------------------------------------------------------------

function generateBenchPoints(count: number): V2d[] {
  const side = Math.round(Math.sqrt(count));
  const extent = 800;
  const points: V2d[] = [];
  for (let iy = 0; iy < side; iy++) {
    const fy = iy / Math.max(1, side - 1);
    const y = -extent + 2 * extent * fy;
    for (let ix = 0; ix < side; ix++) {
      const fx = ix / Math.max(1, side - 1);
      const x = -extent + 2 * extent * fx;
      points.push(V(x, y));
    }
  }
  return points;
}

/** Local extension of `BenchLayout` that carries `totalBytes` for memory sizing. */
type LayoutWithSize = BenchLayout & { totalBytes: number };

function buildLayout(
  heapBase: number,
  pointCount: number,
  worldState: {
    packedTerrain: Uint32Array;
    packedWaveMesh: Uint32Array;
    packedTideMesh: Uint32Array;
    packedWindMesh: Uint32Array | null;
  },
  maxWorkerCount: number,
): LayoutWithSize {
  const ALIGN = 16;
  const align = (n: number): number => (n + ALIGN - 1) & ~(ALIGN - 1);
  const F32 = Float32Array.BYTES_PER_ELEMENT;
  let cursor = heapBase;
  const reserve = (bytes: number): number => {
    cursor = align(cursor);
    const ptr = cursor;
    cursor += bytes;
    return ptr;
  };

  // Per-worker shadow stacks — see `STACK_BYTES_PER_WORKER`. Each entry
  // is the stack TOP; SP starts there and grows down by `STACK_BYTES`.
  cursor = align(cursor);
  const stackTops: number[] = [];
  for (let i = 0; i < maxWorkerCount; i++) {
    cursor += STACK_BYTES_PER_WORKER;
    stackTops.push(cursor);
  }

  const pointsPtr = reserve(pointCount * STRIDE_PER_POINT * F32);
  const paramsPtr = reserve(PARAMS_FLOATS_PER_CHANNEL * F32);
  const resultsPtr = reserve(pointCount * 6 * F32); // sized for water (largest stride)
  const modifiersPtr = reserve(16384 * FLOATS_PER_MODIFIER * F32);

  const packedTerrainPtr = reserve(worldState.packedTerrain.byteLength);
  const packedWaveMeshPtr = reserve(worldState.packedWaveMesh.byteLength);
  const packedTideMeshPtr = reserve(worldState.packedTideMesh.byteLength);
  const packedWindMeshPtr = worldState.packedWindMesh
    ? reserve(worldState.packedWindMesh.byteLength)
    : 0;

  return {
    pointsPtr,
    paramsPtr,
    resultsPtr,
    modifiersPtr,
    packedTerrainPtr,
    packedTerrainLen: worldState.packedTerrain.length,
    packedWaveMeshPtr,
    packedWaveMeshLen: worldState.packedWaveMesh.length,
    packedTideMeshPtr,
    packedTideMeshLen: worldState.packedTideMesh.length,
    packedWindMeshPtr,
    packedWindMeshLen: worldState.packedWindMesh?.length ?? 0,
    pointCount,
    stackTops,
    totalBytes: cursor,
  };
}

function copyU32If(
  buf: ArrayBufferLike,
  ptr: number,
  src: Uint32Array | null,
): void {
  if (!src || src.length === 0 || ptr === 0) return;
  new Uint32Array(buf as ArrayBuffer, ptr, src.length).set(src);
}

function writePointsToBuf(
  buf: ArrayBufferLike,
  ptr: number,
  points: readonly V2d[],
): void {
  const view = new Float32Array(
    buf as ArrayBuffer,
    ptr,
    points.length * STRIDE_PER_POINT,
  );
  for (let i = 0; i < points.length; i++) {
    view[i * STRIDE_PER_POINT] = points[i].x;
    view[i * STRIDE_PER_POINT + 1] = points[i].y;
  }
}

function buildWaterParams(
  wSnap: NonNullable<WaterQueryManager["lastCompletedDispatchParams"]>,
): Float32Array {
  const out = new Float32Array(PARAMS_FLOATS_PER_CHANNEL);
  out[WATER_PARAM_TIME] = wSnap.time;
  out[WATER_PARAM_TIDE_HEIGHT] = wSnap.tideHeight;
  out[WATER_PARAM_DEFAULT_DEPTH] = wSnap.defaultDepth;
  out[WATER_PARAM_NUM_WAVES] = wSnap.numWaves;
  out[WATER_PARAM_TIDAL_PHASE] = wSnap.tidalPhase;
  out[WATER_PARAM_TIDAL_STRENGTH] = wSnap.tidalStrength;
  out[WATER_PARAM_CONTOUR_COUNT] = wSnap.contourCount;
  out[WATER_PARAM_MODIFIER_COUNT] = wSnap.modifierCount;
  const numWavesClamped = Math.min(wSnap.numWaves, WATER_PARAM_MAX_WAVES);
  for (let i = 0; i < numWavesClamped; i++) {
    for (let f = 0; f < WATER_PARAM_FLOATS_PER_WAVE; f++) {
      out[WATER_PARAM_WAVE_SOURCES_BASE + i * WATER_PARAM_FLOATS_PER_WAVE + f] =
        wSnap.waveSources[i * WATER_PARAM_FLOATS_PER_WAVE + f];
    }
  }
  return out;
}

function buildWindParams(
  windSnap: NonNullable<WindQueryManager["lastCompletedDispatchParams"]>,
): Float32Array {
  const out = new Float32Array(PARAMS_FLOATS_PER_CHANNEL);
  out[WIND_PARAM_TIME] = windSnap.time;
  out[WIND_PARAM_BASE_X] = windSnap.baseWindX;
  out[WIND_PARAM_BASE_Y] = windSnap.baseWindY;
  out[WIND_PARAM_INFLUENCE_SPEED_FACTOR] = windSnap.influenceSpeedFactor;
  out[WIND_PARAM_INFLUENCE_DIRECTION_OFFSET] =
    windSnap.influenceDirectionOffset;
  out[WIND_PARAM_INFLUENCE_TURBULENCE] = windSnap.influenceTurbulence;
  for (let i = 0; i < WIND_PARAM_WEIGHTS_COUNT; i++) {
    out[WIND_PARAM_WEIGHTS_BASE + i] = windSnap.weights[i] ?? 0;
  }
  return out;
}

function buildTerrainParams(
  tSnap: NonNullable<TerrainQueryManager["lastCompletedDispatchParams"]>,
): Float32Array {
  const out = new Float32Array(PARAMS_FLOATS_PER_CHANNEL);
  // TERRAIN_PARAM_CONTOUR_COUNT = 0, TERRAIN_PARAM_DEFAULT_DEPTH = 1.
  out[0] = tSnap.contourCount;
  out[1] = tSnap.defaultDepth;
  return out;
}
