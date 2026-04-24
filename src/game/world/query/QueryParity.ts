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
    };
  } finally {
    terrainQuery.destroy();
    waterQuery.destroy();
    windQuery.destroy();
  }
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
