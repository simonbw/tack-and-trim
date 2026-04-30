import { test } from "@playwright/test";

/**
 * Multi-thread microbenchmark.
 *
 * Loads the **San Juan Islands** level (the biggest map — most
 * complex terrain contour tree, biggest wave mesh, most tide mesh
 * data — so per-point compute is genuinely expensive). Then runs
 * `runQueryMicrobench` which spawns dedicated bench workers against
 * a shared `WebAssembly.Memory` and sweeps over
 * `(queryType × engine × workerCount)`.
 *
 * Compared to the production-pool benchmark, this isolates the
 * kernel cost from worker-pool coordination, modifier evolution,
 * cloth/physics scheduling, and GC pressure. The signal it produces
 * is the actual per-point compute under multi-thread execution.
 */

test("Query microbenchmark: JS vs WASM × worker count, San Juan Islands", async ({
  page,
}, testInfo) => {
  testInfo.setTimeout(15 * 60 * 1000);

  page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));
  page.on("console", (msg) => {
    const t = msg.text();
    if (
      t.startsWith("[bench-worker]") ||
      t.startsWith("[QueryMicrobench]") ||
      msg.type() === "error"
    ) {
      console.log(`[browser ${msg.type()}] ${t}`);
    }
  });

  // The microbench reads the GPU managers' `lastCompletedDispatchParams`
  // as its input snapshot, so it requires the GPU backend to be active.
  // The default engine is WASM since the recent backend-default change,
  // so we have to opt in explicitly here.
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("queryEngine", "gpu"));
  await page.reload();
  await page.waitForFunction(() => window.DEBUG?.game, { timeout: 30000 });
  await page.locator(".main-menu").waitFor({ timeout: 30000 });

  // Open the New Game submenu, then click the San Juan Islands level
  // card directly (more reliable than arrow-key navigation, which
  // depends on display order).
  await page.getByRole("button", { name: /new game/i }).click();
  await page.getByRole("button", { name: /san juan islands/i }).click();
  // Boat selector — first card focused by default; press Enter.
  await page.keyboard.press("Enter");

  await page.waitForFunction(() => window.DEBUG.gameStarted === true, {
    timeout: 120000, // Big mesh; loading takes a moment.
  });

  // Let the GPU pipeline round-trip enough frames that all three
  // managers have a `lastCompletedDispatchParams` to snapshot from.
  await page.waitForTimeout(3000);

  const report = await page.evaluate(() => window.DEBUG.runQueryMicrobench!());

  const lines: string[] = [
    `\nMulti-thread microbenchmark — San Juan Islands`,
    `  hardwareConcurrency = ${report.hardwareConcurrency}`,
    `  ${report.pointCount} points × ${report.iterationsPerTrial} iter × ${report.trials} trials per cell`,
    "",
  ];

  const queryTypes = ["water", "wind", "terrain"] as const;
  const engines = ["js", "wasm"] as const;
  const wcs = report.workerCounts;
  const pad = (s: string, n: number): string => s.padStart(n);

  for (const t of queryTypes) {
    lines.push(`${t} — ns/point (mean of ${report.trials} trials):`);
    lines.push(
      `  ${"engine".padEnd(8)}${wcs.map((w) => pad(`w=${w}`, 12)).join("")}`,
    );
    for (const engine of engines) {
      const row = wcs
        .map((w) => {
          const cell = report[t].byWorkerCount[w]?.[engine];
          return pad(cell ? cell.meanNsPerPoint.toFixed(1) : "—", 12);
        })
        .join("");
      lines.push(`  ${engine.padEnd(8)}${row}`);
    }

    // js/wasm speedup ratio per worker count.
    const ratioRow = wcs
      .map((w) => {
        const c = report[t].byWorkerCount[w];
        if (!c?.js || !c?.wasm) return pad("—", 12);
        const r = c.js.meanNsPerPoint / c.wasm.meanNsPerPoint;
        return pad(`${r.toFixed(2)}x`, 12);
      })
      .join("");
    lines.push(`  ${"js/wasm".padEnd(8)}${ratioRow}`);

    // Parallel scaling: ratio of single-thread ns/pt to N-thread
    // ns/pt. Ideal scaling = N (perfect parallel throughput); lower
    // means the kernel is hitting some shared bottleneck (memory
    // bandwidth, scheduling, atomic contention).
    lines.push("  scaling vs w=1 (higher = better parallel efficiency):");
    for (const engine of engines) {
      const base = report[t].byWorkerCount[wcs[0]]?.[engine];
      if (!base) continue;
      const baseNs = base.meanNsPerPoint;
      const row = wcs
        .map((w) => {
          const c = report[t].byWorkerCount[w]?.[engine];
          if (!c) return pad("—", 12);
          const eff = baseNs / c.meanNsPerPoint;
          return pad(`${eff.toFixed(2)}x`, 12);
        })
        .join("");
      lines.push(`    ${engine.padEnd(6)}${row}`);
    }

    // Wall-clock per round (so reader can sanity-check the math).
    lines.push("  wall-clock per round (ms, mean):");
    for (const engine of engines) {
      const row = wcs
        .map((w) => {
          const c = report[t].byWorkerCount[w]?.[engine];
          return pad(c ? c.meanWallClockMs.toFixed(2) : "—", 12);
        })
        .join("");
      lines.push(`    ${engine.padEnd(6)}${row}`);
    }
    lines.push("");
  }

  console.log(lines.join("\n"));
});
