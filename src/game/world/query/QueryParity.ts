/**
 * CPU ↔ GPU query parity check.
 *
 * Both backends compute the same math — GPU via WGSL shaders, CPU via
 * the TypeScript ports in `terrain-math.ts`, `water-math.ts`,
 * `tidal-math.ts`, `wind-math.ts`, and `wind-mesh-math.ts`. This harness
 * drives both paths with the *same* input snapshot and reports per-field
 * diffs so we can assert agreement (modulo f32/f64 precision).
 *
 * How it works:
 *   1. Install a throwaway TerrainQuery/WaterQuery/WindQuery with a
 *      fixed set of test points.
 *   2. Wait until the GPU pipeline has round-tripped a frame of results
 *      for each query.
 *   3. Read each GPU manager's `lastCompletedDispatchParams` — the exact
 *      uniforms and packed-buffer references the GPU used to produce
 *      the results we just got back. (The managers shift pending →
 *      completed inside their `onResultsReady` hook so the snapshot
 *      always matches the current query data.)
 *   4. Call the CPU math functions directly with the same snapshot.
 *   5. Diff every field and return a structured report.
 *
 * Known divergences (not bugs — surfaced here for transparency):
 *
 *   - `water.normal*` — Both sides use finite differences, but near-flat
 *     water (|∂h|² ≈ the 1e-4 threshold) can flip normals between zero
 *     and a normalized direction depending on tiny f32/f64 rounding.
 *   - `wind.velocity*`, `wind.speed` — Two simplex3D samples feed wind
 *     speed/angle noise; f32 vs f64 drift at `floor()` simplex-cell
 *     boundaries cascades into noticeable velocity differences even
 *     when the mesh lookup agrees.
 *
 * The test lives behind `window.DEBUG.runQueryParityCheck` so the
 * Playwright spec can invoke it from the browser.
 */

import type { Game } from "../../../core/Game";
import { V, type V2d } from "../../../core/Vector";
import { TerrainQuery } from "../terrain/TerrainQuery";
import { TerrainQueryManager } from "../terrain/TerrainQueryManager";
import { TerrainResultLayout } from "../terrain/TerrainQueryResult";
import { WaterQuery } from "../water/WaterQuery";
import { WaterQueryManager } from "../water/WaterQueryManager";
import { WaterResultLayout } from "../water/WaterQueryResult";
import { WindQuery } from "../wind/WindQuery";
import { WindQueryManager } from "../wind/WindQueryManager";
import { WindResultLayout } from "../wind/WindQueryResult";
import {
  PARAMS_FLOATS_PER_CHANNEL,
  STRIDE_PER_POINT,
} from "./query-worker-protocol";

// Bitmask values must match the IMPL_BIT_* constants in
// `pipeline/query-wasm/src/lib.rs`.
const WASM_IMPL_BIT_TERRAIN = 1 << 0;
const WASM_IMPL_BIT_WATER = 1 << 1;
const WASM_IMPL_BIT_WIND = 1 << 2;

const FLOATS_PER_MODIFIER = 14;

interface WasmKernelExports {
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
import {
  WATER_PARAM_TIME,
  WATER_PARAM_TIDE_HEIGHT,
  WATER_PARAM_DEFAULT_DEPTH,
  WATER_PARAM_NUM_WAVES,
  WATER_PARAM_TIDAL_PHASE,
  WATER_PARAM_TIDAL_STRENGTH,
  WATER_PARAM_MODIFIER_COUNT,
  WATER_PARAM_CONTOUR_COUNT,
  WATER_PARAM_WAVE_SOURCES_BASE,
  WATER_PARAM_FLOATS_PER_WAVE,
  WATER_PARAM_MAX_WAVES,
} from "./water-params";
import {
  WIND_PARAM_TIME,
  WIND_PARAM_BASE_X,
  WIND_PARAM_BASE_Y,
  WIND_PARAM_INFLUENCE_SPEED_FACTOR,
  WIND_PARAM_INFLUENCE_DIRECTION_OFFSET,
  WIND_PARAM_INFLUENCE_TURBULENCE,
  WIND_PARAM_WEIGHTS_BASE,
  WIND_PARAM_WEIGHTS_COUNT,
} from "./wind-params";
import { writeTerrainResult } from "./terrain-math";
import { writeWaterResult } from "./water-math";
import { writeWindResult } from "./wind-math";
import { lookupWindMeshBlended } from "./wind-mesh-math";

export interface FieldDiff {
  field: string;
  /** Max absolute difference across all points. */
  maxAbs: number;
  /** Mean absolute difference across all points. */
  meanAbs: number;
  /** Index (into the point list) of the worst-disagreeing point. */
  worstIndex: number;
  worstGpu: number;
  worstCpu: number;
  worstPoint: { x: number; y: number };
}

export interface PerTypeReport {
  pointCount: number;
  fields: FieldDiff[];
}

export interface ParityReport {
  pointCount: number;
  terrain: PerTypeReport;
  water: PerTypeReport;
  wind: PerTypeReport;
  /** Count of points where the CPU wind-mesh lookup reported `found === 1`. */
  windMeshCpuHits: number;
  /**
   * Per-type WASM-vs-GPU diffs for any query type the WASM kernel
   * implements. `null` when the wasm module isn't built/loaded, or for
   * types whose `IMPL_BIT_*` flag isn't set yet.
   *
   * Same field semantics as the JS-vs-GPU diffs above; same tolerances
   * generally apply because both diff pairs are dominated by GPU-side
   * trig precision (the GPU uses hardware sincos that drifts from
   * software sincos by a similar amount on either side).
   */
  wasmTerrain: PerTypeReport | null;
  wasmWater: PerTypeReport | null;
  wasmWind: PerTypeReport | null;
  /**
   * Per-type WASM-vs-JS diffs. These are the most informative for
   * verifying the port is correct: both sides see the *same* snapshot
   * inputs, so divergence is bounded by `Math.sin/cos` (V8) vs
   * `f32::sin/cos` (Rust libm) differences. Expect ~1e-3 max abs.
   *
   * `null` for types the WASM kernel doesn't yet implement.
   */
  wasmVsJsTerrain: PerTypeReport | null;
  wasmVsJsWater: PerTypeReport | null;
  wasmVsJsWind: PerTypeReport | null;
  /** Bitmask the wasm kernel reported, or 0 if the kernel didn't load. */
  wasmImplementationMask: number;
}

/**
 * Build a deterministic set of query points. A 24×24 grid over
 * [-1500, 1500] ft covers enough terrain and water in the default level
 * to exercise land/water/mesh/no-mesh codepaths. A few extra off-grid
 * points break up grid-exact alignment.
 */
export function generateParityTestPoints(): V2d[] {
  const points: V2d[] = [];
  const gridSize = 24;
  const extent = 1500;
  for (let iy = 0; iy < gridSize; iy++) {
    const fy = iy / (gridSize - 1);
    const y = -extent + 2 * extent * fy;
    for (let ix = 0; ix < gridSize; ix++) {
      const fx = ix / (gridSize - 1);
      const x = -extent + 2 * extent * fx;
      points.push(V(x, y));
    }
  }
  points.push(V(37.5, -112.25));
  points.push(V(-823.1, 417.9));
  points.push(V(1234.7, -56.3));
  return points;
}

/**
 * Drive one parity check. Requires the GPU backend to be active — the
 * three GPU managers must be present so we can read their dispatch
 * snapshots. Throws if any manager is missing or if results never
 * arrive.
 */
export async function runQueryParityCheck(game: Game): Promise<ParityReport> {
  const terrainMgr = game.entities.tryGetSingleton(TerrainQueryManager);
  const waterMgr = game.entities.tryGetSingleton(WaterQueryManager);
  const windMgr = game.entities.tryGetSingleton(WindQueryManager);
  if (!terrainMgr || !waterMgr || !windMgr) {
    throw new Error(
      "[QueryParity] GPU managers not found — parity check requires the GPU backend.",
    );
  }

  const points = generateParityTestPoints();

  const terrainQuery = game.addEntity(new TerrainQuery(() => points));
  const waterQuery = game.addEntity(new WaterQuery(() => points));
  const windQuery = game.addEntity(new WindQuery(() => points));

  try {
    await waitUntil(
      () =>
        terrainQuery.length === points.length &&
        waterQuery.length === points.length &&
        windQuery.length === points.length &&
        terrainMgr.lastCompletedDispatchParams !== null &&
        waterMgr.lastCompletedDispatchParams !== null &&
        windMgr.lastCompletedDispatchParams !== null,
      /* timeoutMs */ 5000,
    );

    const tSnap = terrainMgr.lastCompletedDispatchParams!;
    const wSnap = waterMgr.lastCompletedDispatchParams!;
    const windSnap = windMgr.lastCompletedDispatchParams!;

    const cpuTerrain = new Float32Array(
      points.length * TerrainResultLayout.stride,
    );
    const cpuWater = new Float32Array(points.length * WaterResultLayout.stride);
    const cpuWind = new Float32Array(points.length * WindResultLayout.stride);
    const windMeshOut = new Float64Array(4);
    let windMeshCpuHits = 0;

    // GPU receives points through a Float32Array (pointsSab), so its
    // inputs are already f32-rounded. Mirror that on the CPU side so
    // cell/triangle picks match at near-boundary points.
    const f32Trunc = new Float32Array(1);
    const truncate = (v: number): number => {
      f32Trunc[0] = v;
      return f32Trunc[0];
    };

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const px = truncate(p.x);
      const py = truncate(p.y);
      writeTerrainResult(
        px,
        py,
        tSnap.packedTerrain,
        tSnap.contourCount,
        tSnap.defaultDepth,
        cpuTerrain,
        i * TerrainResultLayout.stride,
      );
      writeWaterResult(
        px,
        py,
        wSnap.time,
        wSnap.tideHeight,
        wSnap.defaultDepth,
        wSnap.numWaves,
        wSnap.tidalPhase,
        wSnap.tidalStrength,
        wSnap.packedTerrain,
        wSnap.packedWaveMesh,
        wSnap.packedTideMesh,
        wSnap.modifiers,
        wSnap.modifierCount,
        wSnap.waveSources,
        cpuWater,
        i * WaterResultLayout.stride,
      );

      let speedFactor = windSnap.influenceSpeedFactor;
      let dirOffset = windSnap.influenceDirectionOffset;
      let turb = windSnap.influenceTurbulence;
      if (windSnap.packedWindMesh) {
        lookupWindMeshBlended(
          px,
          py,
          windSnap.packedWindMesh,
          windSnap.weights,
          windMeshOut,
        );
        if (windMeshOut[3] > 0) {
          speedFactor = windMeshOut[0];
          dirOffset = windMeshOut[1];
          turb = windMeshOut[2];
          windMeshCpuHits++;
        }
      }
      writeWindResult(
        px,
        py,
        windSnap.time,
        windSnap.baseWindX,
        windSnap.baseWindY,
        speedFactor,
        dirOffset,
        turb,
        cpuWind,
        i * WindResultLayout.stride,
      );
    }

    // Run the wasm kernel against the same point set + uniforms, where
    // available. Each query type is gated on the kernel's implementation
    // mask: types whose port hasn't landed yet stay null.
    const wasm = await runWasmDiffs(
      points,
      terrainQuery._data,
      waterQuery._data,
      windQuery._data,
      cpuTerrain,
      cpuWater,
      cpuWind,
      tSnap,
      wSnap,
      windSnap,
    );

    return {
      pointCount: points.length,
      terrain: diffResults(
        points,
        terrainQuery._data,
        cpuTerrain,
        TerrainResultLayout,
      ),
      water: diffResults(points, waterQuery._data, cpuWater, WaterResultLayout),
      wind: diffResults(points, windQuery._data, cpuWind, WindResultLayout),
      windMeshCpuHits,
      wasmTerrain: wasm.terrain,
      wasmWater: wasm.water,
      wasmWind: wasm.wind,
      wasmVsJsTerrain: wasm.vsJsTerrain,
      wasmVsJsWater: wasm.vsJsWater,
      wasmVsJsWind: wasm.vsJsWind,
      wasmImplementationMask: wasm.mask,
    };
  } finally {
    terrainQuery.destroy();
    waterQuery.destroy();
    windQuery.destroy();
  }
}

interface WasmSnapshots {
  terrain: PerTypeReport | null;
  water: PerTypeReport | null;
  wind: PerTypeReport | null;
  vsJsTerrain: PerTypeReport | null;
  vsJsWater: PerTypeReport | null;
  vsJsWind: PerTypeReport | null;
  mask: number;
}

/**
 * Run the WASM kernel against the same point set as the GPU and compare
 * each implemented query type. Skips silently (returning all-null) if
 * the wasm module fails to load — the JS-vs-GPU comparison will still
 * surface most port bugs.
 */
/**
 * Allocate one shared `WebAssembly.Memory`, partition it into per-type
 * regions matching the runtime worker pool's layout, copy world state
 * in, run each implemented query type through the wasm kernel, and
 * compare the results against both the GPU snapshot and the JS-CPU
 * port.
 *
 * Skips silently if the wasm module fails to load — the JS-vs-GPU
 * comparison will still surface most port bugs.
 */
async function runWasmDiffs(
  points: readonly V2d[],
  gpuTerrain: Float32Array,
  gpuWater: Float32Array,
  gpuWind: Float32Array,
  jsTerrain: Float32Array,
  jsWater: Float32Array,
  jsWind: Float32Array,
  tSnap: NonNullable<TerrainQueryManager["lastCompletedDispatchParams"]>,
  wSnap: NonNullable<WaterQueryManager["lastCompletedDispatchParams"]>,
  windSnap: NonNullable<WindQueryManager["lastCompletedDispatchParams"]>,
): Promise<WasmSnapshots> {
  let layout: WasmTestLayout;
  let memory: WebAssembly.Memory;
  let exports: WasmKernelExports;
  try {
    const url = new URL("./generated/query.wasm", import.meta.url);
    const module = await WebAssembly.compileStreaming(fetch(url));

    // Probe `__heap_base` from a throwaway instance so we know where
    // the wasm's own data+stack region ends. Our partition starts there.
    const probeMemory = new WebAssembly.Memory({
      initial: 17,
      maximum: 17,
      shared: true,
    });
    const probeInstance = await WebAssembly.instantiate(module, {
      env: { memory: probeMemory },
    });
    const heapBase = (probeInstance.exports.__heap_base as WebAssembly.Global)
      .value as number;

    layout = computeTestLayout(
      points.length,
      {
        packedTerrain: tSnap.packedTerrain,
        packedWaveMesh: wSnap.packedWaveMesh,
        packedTideMesh: wSnap.packedTideMesh,
        packedWindMesh: windSnap.packedWindMesh,
      },
      heapBase,
    );
    const initialPages = Math.ceil(layout.totalBytes / 65536) + 16;
    memory = new WebAssembly.Memory({
      initial: initialPages,
      maximum: 65536,
      shared: true,
    });
    // Copy world state into shared memory before instantiation so the
    // pointer pairs we register are usable from the first call.
    if (tSnap.packedTerrain) {
      new Uint32Array(
        memory.buffer,
        layout.packedTerrainPtr,
        tSnap.packedTerrain.length,
      ).set(tSnap.packedTerrain);
    }
    if (wSnap.packedWaveMesh) {
      new Uint32Array(
        memory.buffer,
        layout.packedWaveMeshPtr,
        wSnap.packedWaveMesh.length,
      ).set(wSnap.packedWaveMesh);
    }
    if (wSnap.packedTideMesh) {
      new Uint32Array(
        memory.buffer,
        layout.packedTideMeshPtr,
        wSnap.packedTideMesh.length,
      ).set(wSnap.packedTideMesh);
    }
    if (windSnap.packedWindMesh) {
      new Uint32Array(
        memory.buffer,
        layout.packedWindMeshPtr,
        windSnap.packedWindMesh.length,
      ).set(windSnap.packedWindMesh);
    }

    const instance = await WebAssembly.instantiate(module, {
      env: { memory },
    });
    exports = instance.exports as unknown as WasmKernelExports;
    if (tSnap.packedTerrain) {
      exports.set_packed_terrain(
        layout.packedTerrainPtr,
        tSnap.packedTerrain.length,
      );
    }
    if (wSnap.packedWaveMesh) {
      exports.set_packed_wave_mesh(
        layout.packedWaveMeshPtr,
        wSnap.packedWaveMesh.length,
      );
    }
    if (wSnap.packedTideMesh) {
      exports.set_packed_tide_mesh(
        layout.packedTideMeshPtr,
        wSnap.packedTideMesh.length,
      );
    }
    if (windSnap.packedWindMesh) {
      exports.set_packed_wind_mesh(
        layout.packedWindMeshPtr,
        windSnap.packedWindMesh.length,
      );
    }
  } catch (err) {
    console.warn(
      "[QueryParity] wasm kernel unavailable — skipping wasm diffs",
      err,
    );
    return {
      terrain: null,
      water: null,
      wind: null,
      vsJsTerrain: null,
      vsJsWater: null,
      vsJsWind: null,
      mask: 0,
    };
  }

  const mask = exports.query_implementation_mask();
  const out: WasmSnapshots = {
    terrain: null,
    water: null,
    wind: null,
    vsJsTerrain: null,
    vsJsWater: null,
    vsJsWind: null,
    mask,
  };

  // Mirror the f32-truncation we apply on the JS-CPU side so simplex
  // cell decisions and triangle picks match GPU at near-boundary points.
  const f32Trunc = new Float32Array(1);
  const truncate = (v: number): number => {
    f32Trunc[0] = v;
    return f32Trunc[0];
  };

  if (mask & WASM_IMPL_BIT_WATER) {
    const wasmWater = runWasmWater(
      memory,
      exports,
      layout,
      points,
      wSnap,
      truncate,
    );
    out.water = diffResults(points, gpuWater, wasmWater, WaterResultLayout);
    out.vsJsWater = diffResults(points, jsWater, wasmWater, WaterResultLayout);
  }
  if (mask & WASM_IMPL_BIT_WIND) {
    const wasmWind = runWasmWind(
      memory,
      exports,
      layout,
      points,
      windSnap,
      truncate,
    );
    out.wind = diffResults(points, gpuWind, wasmWind, WindResultLayout);
    out.vsJsWind = diffResults(points, jsWind, wasmWind, WindResultLayout);
  }
  if (mask & WASM_IMPL_BIT_TERRAIN) {
    const wasmTerrain = runWasmTerrain(
      memory,
      exports,
      layout,
      points,
      tSnap,
      truncate,
    );
    out.terrain = diffResults(
      points,
      gpuTerrain,
      wasmTerrain,
      TerrainResultLayout,
    );
    out.vsJsTerrain = diffResults(
      points,
      jsTerrain,
      wasmTerrain,
      TerrainResultLayout,
    );
  }

  return out;
}

/**
 * Manual partition map for the parity harness. Mirrors the layout
 * `QueryWorkerPool.computePartition` produces at runtime, but sized to
 * the harness's deterministic point set rather than `MAX_POINTS`.
 */
interface WasmTestLayout {
  terrainPointsPtr: number;
  terrainParamsPtr: number;
  terrainResultsPtr: number;
  waterPointsPtr: number;
  waterParamsPtr: number;
  waterResultsPtr: number;
  waterModifiersPtr: number;
  waterModifiersBytes: number;
  windPointsPtr: number;
  windParamsPtr: number;
  windResultsPtr: number;
  packedTerrainPtr: number;
  packedWaveMeshPtr: number;
  packedTideMeshPtr: number;
  packedWindMeshPtr: number;
  totalBytes: number;
}

function computeTestLayout(
  pointCount: number,
  worldState: {
    packedTerrain: Uint32Array | null;
    packedWaveMesh: Uint32Array | null;
    packedTideMesh: Uint32Array | null;
    packedWindMesh: Uint32Array | null;
  },
  heapBase: number,
): WasmTestLayout {
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

  const terrainPointsPtr = reserve(pointCount * STRIDE_PER_POINT * F32);
  const terrainParamsPtr = reserve(PARAMS_FLOATS_PER_CHANNEL * F32);
  const terrainResultsPtr = reserve(
    pointCount * TerrainResultLayout.stride * F32,
  );

  const waterPointsPtr = reserve(pointCount * STRIDE_PER_POINT * F32);
  const waterParamsPtr = reserve(PARAMS_FLOATS_PER_CHANNEL * F32);
  const waterResultsPtr = reserve(pointCount * WaterResultLayout.stride * F32);
  // Modifiers buffer sized to the snapshot's count — the harness only
  // runs the snapshot's modifierCount worth of data.
  const waterModifiersBytes = 16384 * FLOATS_PER_MODIFIER * F32;
  const waterModifiersPtr = reserve(waterModifiersBytes);

  const windPointsPtr = reserve(pointCount * STRIDE_PER_POINT * F32);
  const windParamsPtr = reserve(PARAMS_FLOATS_PER_CHANNEL * F32);
  const windResultsPtr = reserve(pointCount * WindResultLayout.stride * F32);

  const packedTerrainPtr = worldState.packedTerrain
    ? reserve(worldState.packedTerrain.byteLength)
    : 0;
  const packedWaveMeshPtr = worldState.packedWaveMesh
    ? reserve(worldState.packedWaveMesh.byteLength)
    : 0;
  const packedTideMeshPtr = worldState.packedTideMesh
    ? reserve(worldState.packedTideMesh.byteLength)
    : 0;
  const packedWindMeshPtr = worldState.packedWindMesh
    ? reserve(worldState.packedWindMesh.byteLength)
    : 0;

  return {
    terrainPointsPtr,
    terrainParamsPtr,
    terrainResultsPtr,
    waterPointsPtr,
    waterParamsPtr,
    waterResultsPtr,
    waterModifiersPtr,
    waterModifiersBytes,
    windPointsPtr,
    windParamsPtr,
    windResultsPtr,
    packedTerrainPtr,
    packedWaveMeshPtr,
    packedTideMeshPtr,
    packedWindMeshPtr,
    totalBytes: cursor,
  };
}

function runWasmWater(
  memory: WebAssembly.Memory,
  exports: WasmKernelExports,
  layout: WasmTestLayout,
  points: readonly V2d[],
  wSnap: NonNullable<WaterQueryManager["lastCompletedDispatchParams"]>,
  truncate: (v: number) => number,
): Float32Array {
  const buf = memory.buffer;
  const pointsView = new Float32Array(
    buf,
    layout.waterPointsPtr,
    points.length * STRIDE_PER_POINT,
  );
  for (let i = 0; i < points.length; i++) {
    pointsView[i * STRIDE_PER_POINT] = truncate(points[i].x);
    pointsView[i * STRIDE_PER_POINT + 1] = truncate(points[i].y);
  }

  const paramsView = new Float32Array(
    buf,
    layout.waterParamsPtr,
    PARAMS_FLOATS_PER_CHANNEL,
  );
  paramsView.fill(0);
  paramsView[WATER_PARAM_TIME] = wSnap.time;
  paramsView[WATER_PARAM_TIDE_HEIGHT] = wSnap.tideHeight;
  paramsView[WATER_PARAM_DEFAULT_DEPTH] = wSnap.defaultDepth;
  paramsView[WATER_PARAM_NUM_WAVES] = wSnap.numWaves;
  paramsView[WATER_PARAM_TIDAL_PHASE] = wSnap.tidalPhase;
  paramsView[WATER_PARAM_TIDAL_STRENGTH] = wSnap.tidalStrength;
  paramsView[WATER_PARAM_CONTOUR_COUNT] = wSnap.contourCount;
  paramsView[WATER_PARAM_MODIFIER_COUNT] = wSnap.modifierCount;
  const numWavesClamped = Math.min(wSnap.numWaves, WATER_PARAM_MAX_WAVES);
  for (let i = 0; i < numWavesClamped; i++) {
    for (let f = 0; f < WATER_PARAM_FLOATS_PER_WAVE; f++) {
      paramsView[
        WATER_PARAM_WAVE_SOURCES_BASE + i * WATER_PARAM_FLOATS_PER_WAVE + f
      ] = wSnap.waveSources[i * WATER_PARAM_FLOATS_PER_WAVE + f];
    }
  }

  if (wSnap.modifierCount > 0) {
    const floats = wSnap.modifierCount * FLOATS_PER_MODIFIER;
    const modsView = new Float32Array(
      buf,
      layout.waterModifiersPtr,
      layout.waterModifiersBytes / Float32Array.BYTES_PER_ELEMENT,
    );
    modsView.set(
      wSnap.modifiers.subarray(0, Math.min(floats, modsView.length)),
    );
  }

  exports.process_water_batch(
    layout.waterPointsPtr,
    points.length,
    layout.waterParamsPtr,
    layout.waterModifiersPtr,
    wSnap.modifierCount,
    layout.waterResultsPtr,
    WaterResultLayout.stride,
  );

  const resultsView = new Float32Array(
    buf,
    layout.waterResultsPtr,
    points.length * WaterResultLayout.stride,
  );
  return new Float32Array(resultsView);
}

function runWasmWind(
  memory: WebAssembly.Memory,
  exports: WasmKernelExports,
  layout: WasmTestLayout,
  points: readonly V2d[],
  windSnap: NonNullable<WindQueryManager["lastCompletedDispatchParams"]>,
  truncate: (v: number) => number,
): Float32Array {
  const buf = memory.buffer;
  const pointsView = new Float32Array(
    buf,
    layout.windPointsPtr,
    points.length * STRIDE_PER_POINT,
  );
  for (let i = 0; i < points.length; i++) {
    pointsView[i * STRIDE_PER_POINT] = truncate(points[i].x);
    pointsView[i * STRIDE_PER_POINT + 1] = truncate(points[i].y);
  }

  const paramsView = new Float32Array(
    buf,
    layout.windParamsPtr,
    PARAMS_FLOATS_PER_CHANNEL,
  );
  paramsView.fill(0);
  paramsView[WIND_PARAM_TIME] = windSnap.time;
  paramsView[WIND_PARAM_BASE_X] = windSnap.baseWindX;
  paramsView[WIND_PARAM_BASE_Y] = windSnap.baseWindY;
  paramsView[WIND_PARAM_INFLUENCE_SPEED_FACTOR] = windSnap.influenceSpeedFactor;
  paramsView[WIND_PARAM_INFLUENCE_DIRECTION_OFFSET] =
    windSnap.influenceDirectionOffset;
  paramsView[WIND_PARAM_INFLUENCE_TURBULENCE] = windSnap.influenceTurbulence;
  for (let i = 0; i < WIND_PARAM_WEIGHTS_COUNT; i++) {
    paramsView[WIND_PARAM_WEIGHTS_BASE + i] = windSnap.weights[i] ?? 0;
  }

  exports.process_wind_batch(
    layout.windPointsPtr,
    points.length,
    layout.windParamsPtr,
    layout.windResultsPtr,
    WindResultLayout.stride,
  );

  const resultsView = new Float32Array(
    buf,
    layout.windResultsPtr,
    points.length * WindResultLayout.stride,
  );
  return new Float32Array(resultsView);
}

function runWasmTerrain(
  memory: WebAssembly.Memory,
  exports: WasmKernelExports,
  layout: WasmTestLayout,
  points: readonly V2d[],
  tSnap: NonNullable<TerrainQueryManager["lastCompletedDispatchParams"]>,
  truncate: (v: number) => number,
): Float32Array {
  const buf = memory.buffer;
  const pointsView = new Float32Array(
    buf,
    layout.terrainPointsPtr,
    points.length * STRIDE_PER_POINT,
  );
  for (let i = 0; i < points.length; i++) {
    pointsView[i * STRIDE_PER_POINT] = truncate(points[i].x);
    pointsView[i * STRIDE_PER_POINT + 1] = truncate(points[i].y);
  }

  const paramsView = new Float32Array(
    buf,
    layout.terrainParamsPtr,
    PARAMS_FLOATS_PER_CHANNEL,
  );
  paramsView.fill(0);
  // TERRAIN_PARAM_DEFAULT_DEPTH = 1 in `terrain-params.ts`.
  paramsView[1] = tSnap.defaultDepth;

  exports.process_terrain_batch(
    layout.terrainPointsPtr,
    points.length,
    layout.terrainParamsPtr,
    layout.terrainResultsPtr,
    TerrainResultLayout.stride,
  );

  const resultsView = new Float32Array(
    buf,
    layout.terrainResultsPtr,
    points.length * TerrainResultLayout.stride,
  );
  return new Float32Array(resultsView);
}

function diffResults(
  points: readonly V2d[],
  gpu: Float32Array,
  cpu: Float32Array,
  layout: { stride: number; fields: Record<string, number> },
): PerTypeReport {
  const fields: FieldDiff[] = [];
  for (const [name, offset] of Object.entries(layout.fields)) {
    let maxAbs = 0;
    let sumAbs = 0;
    let worstIndex = 0;
    let worstGpu = 0;
    let worstCpu = 0;
    for (let i = 0; i < points.length; i++) {
      const base = i * layout.stride + offset;
      const g = gpu[base];
      const c = cpu[base];
      const d = Math.abs(g - c);
      sumAbs += d;
      if (d > maxAbs) {
        maxAbs = d;
        worstIndex = i;
        worstGpu = g;
        worstCpu = c;
      }
    }
    fields.push({
      field: name,
      maxAbs,
      meanAbs: sumAbs / points.length,
      worstIndex,
      worstGpu,
      worstCpu,
      worstPoint: { x: points[worstIndex].x, y: points[worstIndex].y },
    });
  }
  return { pointCount: points.length, fields };
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeoutMs) {
      throw new Error(
        `[QueryParity] timed out waiting for GPU queries to produce results`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
}
