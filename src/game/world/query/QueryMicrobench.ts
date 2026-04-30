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
import type { BaseQuery } from "./BaseQuery";
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
  BARRIER_GENERATION,
  BARRIER_REMAINING,
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

// Mirrors `MAX_WATER_MODIFIERS` and `FLOATS_PER_MODIFIER` in
// `CpuQueryCoordinator.ts`. Kept local to avoid an import cycle, but
// the values must agree.
const MAX_MODIFIERS = 16384;
const FLOATS_PER_MODIFIER = 14;
/** Worst-case result stride — water has 6 floats, terrain/wind have 4. */
const MAX_RESULT_STRIDE = 6;
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

/**
 * Run the full multi-thread sweep. Requires the GPU backend to be
 * active so we can capture `lastCompletedDispatchParams` from each
 * query manager (used as the bench's input snapshot).
 */
export async function runQueryMicrobench(
  game: Game,
): Promise<MicrobenchReport> {
  const env = await setupBenchEnvironment(game);

  const hardwareConcurrency =
    (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
  const workerCounts = pickWorkerCounts(hardwareConcurrency);

  // One memory shared across every cell — workers in different cells
  // receive the same offsets, so we reserve a per-worker shadow stack
  // for the largest worker count we'll sweep.
  const points = generateBenchPoints(POINT_COUNT);
  const { layout, memory } = allocateBenchMemory(
    env,
    points,
    Math.max(...workerCounts),
  );

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
          memory.buffer,
          layout.paramsPtr,
          PARAMS_FLOATS_PER_CHANNEL,
        ).set(env.paramsByType[queryType]);

        const stats = await runCell(
          memory,
          env.wasmModule,
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

/**
 * Shared bench setup — captures dispatch params snapshots from the GPU
 * managers, compiles the wasm module, probes its `__heap_base`, and
 * builds the per-type params blocks. Used by both the synthetic-grid
 * sweep and the live-points bench.
 */
interface BenchEnvironment {
  wasmModule: WebAssembly.Module;
  heapBase: number;
  tSnap: NonNullable<TerrainQueryManager["lastCompletedDispatchParams"]>;
  wSnap: NonNullable<WaterQueryManager["lastCompletedDispatchParams"]>;
  windSnap: NonNullable<WindQueryManager["lastCompletedDispatchParams"]>;
  paramsByType: Record<BenchQueryType, Float32Array>;
}

async function setupBenchEnvironment(game: Game): Promise<BenchEnvironment> {
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

  const url = new URL("./generated/query.wasm", import.meta.url);
  const wasmModule = await WebAssembly.compileStreaming(fetch(url));
  // Throwaway instance just to read `__heap_base` — the real workers
  // get their own Instances against the bench's shared memory below.
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

  const paramsByType: Record<BenchQueryType, Float32Array> = {
    water: buildWaterParams(wSnap),
    wind: buildWindParams(windSnap),
    terrain: buildTerrainParams(tSnap),
  };
  return { wasmModule, heapBase, tSnap, wSnap, windSnap, paramsByType };
}

/**
 * Reserve a fresh shared `WebAssembly.Memory`, build a layout sized to
 * the given point count + worker count, copy world state in, and write
 * the points into the shared region. Caller still has to write the
 * per-type params block before kicking off a cell.
 */
function allocateBenchMemory(
  env: BenchEnvironment,
  points: readonly V2d[],
  workerCount: number,
): { layout: LayoutWithSize; memory: WebAssembly.Memory } {
  const layout = buildLayout(
    env.heapBase,
    points.length,
    {
      packedTerrain: env.tSnap.packedTerrain,
      packedWaveMesh: env.wSnap.packedWaveMesh,
      packedTideMesh: env.wSnap.packedTideMesh,
      packedWindMesh: env.windSnap.packedWindMesh,
    },
    workerCount,
  );
  const initialPages = Math.ceil(layout.totalBytes / 65536) + 16;
  const memory = new WebAssembly.Memory({
    initial: initialPages,
    maximum: 65536,
    shared: true,
  });
  const buffer = memory.buffer;
  copyU32If(buffer, layout.packedTerrainPtr, env.tSnap.packedTerrain);
  copyU32If(buffer, layout.packedWaveMeshPtr, env.wSnap.packedWaveMesh);
  copyU32If(buffer, layout.packedTideMeshPtr, env.wSnap.packedTideMesh);
  copyU32If(buffer, layout.packedWindMeshPtr, env.windSnap.packedWindMesh);
  writePointsToBuf(buffer, layout.pointsPtr, points);

  // Modifier table copy (water only). Other types' modifier regions
  // stay at zero, which the wasm reads as `modifierCount=0` from params.
  if (env.wSnap.modifierCount > 0) {
    const floats = env.wSnap.modifierCount * FLOATS_PER_MODIFIER;
    const modsView = new Float32Array(
      buffer,
      layout.modifiersPtr,
      MAX_MODIFIERS * FLOATS_PER_MODIFIER,
    );
    modsView.set(
      env.wSnap.modifiers.subarray(0, Math.min(floats, modsView.length)),
    );
  }
  return { layout, memory };
}

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
  const resultsPtr = reserve(pointCount * MAX_RESULT_STRIDE * F32);
  const modifiersPtr = reserve(MAX_MODIFIERS * FLOATS_PER_MODIFIER * F32);

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
  buf: ArrayBuffer,
  ptr: number,
  src: Uint32Array | null,
): void {
  if (!src || src.length === 0 || ptr === 0) return;
  new Uint32Array(buf, ptr, src.length).set(src);
}

function writePointsToBuf(
  buf: ArrayBuffer,
  ptr: number,
  points: readonly V2d[],
): void {
  const view = new Float32Array(buf, ptr, points.length * STRIDE_PER_POINT);
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

// ---------------------------------------------------------------------------
// Live-points bench
// ---------------------------------------------------------------------------

export interface LivePointsCellStats {
  pointCount: number;
  meanWallClockMs: number;
  meanNsPerPoint: number;
}

export interface LivePointsReport {
  workerCount: number;
  iterationsPerTrial: number;
  trials: number;
  water: LivePointsCellStats | null;
  wind: LivePointsCellStats | null;
  terrain: LivePointsCellStats | null;
}

const LIVE_POINTS_QUERY_TAGS: Record<BenchQueryType, string> = {
  water: "waterQuery",
  wind: "windQuery",
  terrain: "terrainQuery",
};

/**
 * Variant of `runQueryMicrobench` that uses the *actual* point set the
 * production query system is dispatching on the current frame, rather
 * than the synthetic 1024-point uniform grid. Direct apples-to-apples
 * comparison with the in-game `query.<type>.usPerPt` profiler labels:
 * if the live-points cells match the in-game per-point cost, the gap
 * is point-distribution / world-state. If they instead match the
 * synthetic-grid cells, the gap is in production worker dispatch
 * (parking, contention, etc.).
 *
 * Only runs WASM at one worker count (the production heuristic) and
 * one iteration per trial — enough cells for a noise-aware mean.
 */
export async function runLivePointsMicrobench(
  game: Game,
): Promise<LivePointsReport> {
  const env = await setupBenchEnvironment(game);

  const livePoints: Record<BenchQueryType, V2d[]> = {
    water: gatherLivePoints(game, "water"),
    wind: gatherLivePoints(game, "wind"),
    terrain: gatherLivePoints(game, "terrain"),
  };
  console.log(
    `[QueryMicrobench:live] points captured — water=${livePoints.water.length} wind=${livePoints.wind.length} terrain=${livePoints.terrain.length}`,
  );

  const hardwareConcurrency =
    (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
  const workerCount = Math.max(hardwareConcurrency - 4, 2);

  const out: LivePointsReport = {
    workerCount,
    iterationsPerTrial: 1,
    trials: TRIALS,
    water: null,
    wind: null,
    terrain: null,
  };

  for (const queryType of QUERY_TYPES) {
    const points = livePoints[queryType];
    if (points.length === 0) continue;
    // Each type gets its own memory because the layout depends on point
    // count (which differs per type for a real frame).
    const { layout, memory } = allocateBenchMemory(env, points, workerCount);
    new Float32Array(
      memory.buffer,
      layout.paramsPtr,
      PARAMS_FLOATS_PER_CHANNEL,
    ).set(env.paramsByType[queryType]);

    console.log(
      `[QueryMicrobench:live] cell type=${queryType} points=${points.length} workerCount=${workerCount}`,
    );
    const stats = await runCell(
      memory,
      env.wasmModule,
      layout,
      "wasm",
      queryType,
      workerCount,
      points.length,
      // One call per trial so each trial matches the in-game cadence
      // (one wasm batch per worker per frame).
      1,
    );
    out[queryType] = {
      pointCount: points.length,
      meanWallClockMs: stats.meanWallClockMs,
      meanNsPerPoint: stats.meanNsPerPoint,
    };
  }

  return out;
}

function gatherLivePoints(game: Game, queryType: BenchQueryType): V2d[] {
  const tag = LIVE_POINTS_QUERY_TAGS[queryType];
  const out: V2d[] = [];
  for (const e of game.entities.getTagged(tag)) {
    const q = e as unknown as BaseQuery<unknown>;
    for (const p of q.points) out.push(p);
  }
  return out;
}
