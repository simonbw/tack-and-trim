import { test, expect } from "@playwright/test";

/**
 * Smoke test for the CPU+WASM engine. Loads the game with
 * `queryBackend = cpu, queryCpuEngine = wasm`, gets into a level, and
 * verifies that no console errors fire and that workers report
 * non-zero per-frame compute time (i.e. they're actually running).
 *
 * This catches the kind of regression that the parity test can't —
 * single-worker, single-instance wasm vs the production multi-worker
 * shared-memory setup.
 */

test("CPU+WASM engine: workers run without errors and report timings", async ({
  page,
}) => {
  const issues: string[] = [];
  page.on("pageerror", (err) => {
    issues.push(`pageerror: ${err.message}`);
  });
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      issues.push(`${msg.type()}: ${msg.text()}`);
    }
  });

  await page.addInitScript(() => {
    localStorage.setItem("queryBackend", "cpu");
    localStorage.setItem("queryCpuEngine", "wasm");
  });
  await page.goto("/");

  await page.waitForFunction(() => window.DEBUG?.game, { timeout: 30000 });
  await expect(page.locator(".main-menu")).toBeVisible({ timeout: 30000 });
  await page.keyboard.press("Enter"); // New Game
  await page.keyboard.press("Enter"); // default level
  await page.keyboard.press("Enter"); // default boat
  await page.waitForFunction(() => window.DEBUG.gameStarted === true, {
    timeout: 60000,
  });

  // Let workers warm up — wasm compile + initial frames.
  await page.waitForTimeout(3000);

  const stats = await page.evaluate(() => {
    const all = window.DEBUG.getAsyncProfilerStats?.() ?? [];
    return all
      .filter((s) => s.label.startsWith("QueryWorkers."))
      .map((s) => ({ label: s.label, ms: s.callbackMsPerFrame }));
  });
  console.log("WASM-engine worker stats:", JSON.stringify(stats));

  // At least one query type should have produced timing data — a
  // non-zero callbackMsPerFrame implies workers actually executed
  // process_*_batch and reported back.
  const totalMs = stats.reduce((a, s) => a + s.ms, 0);
  expect(totalMs, "QueryWorkers reported zero compute time").toBeGreaterThan(0);

  expect(issues, issues.join("\n")).toHaveLength(0);
});
