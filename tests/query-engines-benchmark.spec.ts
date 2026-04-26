import { test } from "@playwright/test";

/**
 * In-game query backend benchmark — sweeps over `(workerCount × engine)`
 * and reports the per-frame compute cost the worker pool itself sees.
 *
 * For each cell, the spec:
 *   1. Sets `queryBackend = "cpu"`, plus the cell's `cpuEngine` and
 *      `queryWorkerCount` in localStorage via `addInitScript`.
 *   2. Reloads the game from scratch (fresh worker pool, fresh wasm
 *      memory, fresh JIT).
 *   3. Walks through the menu, lets the level boot, waits a warmup
 *      window, and samples `asyncProfiler.getStats()` repeatedly.
 *   4. Reports the lowest steady-state sample across the measure
 *      window — single-sample minimum is more noise-resistant than a
 *      mean over a window where `asyncProfiler` smoothing introduces
 *      autocorrelation between samples.
 *
 * Two views per query type:
 *   - **sum** = `asyncProfiler.callbackMsPerFrame`, which is the total
 *     CPU effort across all workers. Useful for "how much work is the
 *     pool doing" and scales roughly linearly with worker count for a
 *     fixed point load.
 *   - **wall** ≈ sum / workerCount, an estimate of the actual per-frame
 *     latency assuming work splits evenly across workers. The number
 *     to look at if you care about frame budget impact.
 *
 * Caveat: this is a noisy harness compared to
 * `tests/query-microbenchmark.spec.ts`. Use the microbench for
 * authoritative per-point cost; use this one for "how does the
 * production pipeline behave under different worker counts?"
 */

const WARMUP_MS = 4000;
const MEASURE_MS = 6000;
const SAMPLE_INTERVAL_MS = 200;

const QUERY_TYPES = ["water", "wind", "terrain"] as const;
type QueryTypeName = (typeof QUERY_TYPES)[number];

interface CellResult {
  /** Lowest sum-of-workers ms/frame seen during the measurement window. */
  sumMs: Record<QueryTypeName, number>;
  /** Per-type point count from the most recent submit during the window. */
  pointCount: Record<QueryTypeName, number>;
}

interface CellSpec {
  engine: "js" | "wasm";
  workerCount: number;
}

/** Default sweep: 1, 2, 4, default-heuristic. Good coverage on most laptops. */
function workerCountsFor(hardwareConcurrency: number): number[] {
  const heuristicDefault = Math.max(hardwareConcurrency - 4, 2);
  const counts = new Set<number>([1, 2, 4, heuristicDefault]);
  return [...counts].sort((a, b) => a - b);
}

async function captureCell(
  page: import("@playwright/test").Page,
  cell: CellSpec,
): Promise<CellResult> {
  await page.addInitScript((c: CellSpec) => {
    localStorage.setItem("queryBackend", "cpu");
    localStorage.setItem("queryCpuEngine", c.engine);
    localStorage.setItem("queryWorkerCount", String(c.workerCount));
  }, cell);

  await page.goto("/");
  await page.waitForFunction(() => window.DEBUG?.game, { timeout: 30000 });
  await page.locator(".main-menu").waitFor({ timeout: 30000 });
  await page.keyboard.press("Enter"); // New Game
  await page.keyboard.press("Enter"); // default level
  await page.keyboard.press("Enter"); // default boat
  await page.waitForFunction(() => window.DEBUG.gameStarted === true, {
    timeout: 60000,
  });

  await page.waitForTimeout(WARMUP_MS);

  const sampleCount = Math.ceil(MEASURE_MS / SAMPLE_INTERVAL_MS);
  const minPerType: Record<QueryTypeName, number> = {
    water: Infinity,
    wind: Infinity,
    terrain: Infinity,
  };
  for (let i = 0; i < sampleCount; i++) {
    const stats = await page.evaluate(() => {
      const all = window.DEBUG.getAsyncProfilerStats?.() ?? [];
      const out: Record<string, number> = {};
      for (const s of all) {
        if (s.label.startsWith("QueryWorkers.")) {
          out[s.label] = s.callbackMsPerFrame;
        }
      }
      return out;
    });
    for (const t of QUERY_TYPES) {
      const v = stats[`QueryWorkers.${t}`] ?? 0;
      if (v > 0 && v < minPerType[t]) minPerType[t] = v;
    }
    await page.waitForTimeout(SAMPLE_INTERVAL_MS);
  }
  for (const t of QUERY_TYPES) {
    if (!Number.isFinite(minPerType[t])) minPerType[t] = 0;
  }

  const pointCount = await page.evaluate(() => {
    const counts = window.DEBUG.getLastQueryPointCounts?.();
    return counts ?? { terrain: 0, water: 0, wind: 0 };
  });

  return { sumMs: minPerType, pointCount };
}

test("CPU engines benchmark: WASM vs JS across worker counts", async ({
  page,
}, testInfo) => {
  const hardwareConcurrency = await page.evaluate(
    () => navigator.hardwareConcurrency,
  );
  const workerCounts = workerCountsFor(hardwareConcurrency);
  const engines: Array<"js" | "wasm"> = ["js", "wasm"];

  // Each cell takes ~15s (page load + warmup + measure). 8 cells ≈
  // 2 minutes; bump generously.
  testInfo.setTimeout(15 * 60 * 1000);

  // results[engine][workerCount] = CellResult
  const results: Record<string, Record<number, CellResult>> = {
    js: {},
    wasm: {},
  };
  for (const engine of engines) {
    for (const wc of workerCounts) {
      const cell = await captureCell(page, { engine, workerCount: wc });
      results[engine][wc] = cell;
      // Clear init scripts between cells so the next addInitScript
      // doesn't stack onto stale state.
      await page.context().clearCookies();
    }
  }

  const lines: string[] = [
    `\nCPU engines benchmark (hardwareConcurrency=${hardwareConcurrency}, lowest sum-ms/frame seen during measure window):`,
    `  workerCounts swept: ${workerCounts.join(", ")}`,
    "",
  ];

  // Sum view: raw asyncProfiler numbers.
  lines.push("Sum across workers (CPU effort, ms/frame):");
  lines.push(
    `  ${"type/engine".padEnd(20)}${workerCounts
      .map((w) => `w=${w}`.padStart(10))
      .join("")}`,
  );
  for (const t of QUERY_TYPES) {
    for (const engine of engines) {
      const row = workerCounts
        .map((w) => results[engine][w].sumMs[t].toFixed(2).padStart(10))
        .join("");
      lines.push(`  ${`${t}/${engine}`.padEnd(20)}${row}`);
    }
  }
  lines.push("");

  // Wall-clock view: sum / workerCount as an even-slicing estimate.
  lines.push("Estimated wall-clock per frame (sum / workerCount, ms/frame):");
  lines.push(
    `  ${"type/engine".padEnd(20)}${workerCounts
      .map((w) => `w=${w}`.padStart(10))
      .join("")}`,
  );
  for (const t of QUERY_TYPES) {
    for (const engine of engines) {
      const row = workerCounts
        .map((w) => (results[engine][w].sumMs[t] / w).toFixed(2).padStart(10))
        .join("");
      lines.push(`  ${`${t}/${engine}`.padEnd(20)}${row}`);
    }
  }
  lines.push("");

  // Speedup view: js / wasm per-cell.
  lines.push("Speedup (js.sum / wasm.sum) — values >1 mean WASM is faster:");
  lines.push(
    `  ${"type".padEnd(20)}${workerCounts
      .map((w) => `w=${w}`.padStart(10))
      .join("")}`,
  );
  for (const t of QUERY_TYPES) {
    const row = workerCounts
      .map((w) => {
        const wasm = results.wasm[w].sumMs[t];
        const js = results.js[w].sumMs[t];
        const ratio = wasm > 0 ? js / wasm : NaN;
        return Number.isFinite(ratio)
          ? `${ratio.toFixed(2)}x`.padStart(10)
          : "n/a".padStart(10);
      })
      .join("");
    lines.push(`  ${t.padEnd(20)}${row}`);
  }
  lines.push("");

  // Workload sanity check: per-frame point counts. Lets the reader
  // judge whether the sum-ms/frame values match the per-point cost
  // from the microbench. If point counts are tiny the engine
  // difference will be dwarfed by per-call overhead and the
  // production benchmark will (correctly) report a flat result even
  // when WASM is much faster per point.
  lines.push("Per-frame point counts (last submit during measure window):");
  lines.push(
    `  ${"type/engine".padEnd(20)}${workerCounts
      .map((w) => `w=${w}`.padStart(10))
      .join("")}`,
  );
  for (const t of QUERY_TYPES) {
    for (const engine of engines) {
      const row = workerCounts
        .map((w) => `${results[engine][w].pointCount[t]}`.padStart(10))
        .join("");
      lines.push(`  ${`${t}/${engine}`.padEnd(20)}${row}`);
    }
  }

  console.log(lines.join("\n"));
});
