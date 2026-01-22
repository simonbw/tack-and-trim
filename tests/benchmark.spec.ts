import { test, expect } from "@playwright/test";

const ITERATIONS = 5;

interface BenchmarkResult {
  total: number;
  wind: number;
  swell: number;
  fetch: number;
  cores: number;
  swellUsedGPU: boolean;
}

async function runSingleBenchmark(
  page: import("@playwright/test").Page,
  options: { logConsole?: boolean; forceCPUSwell?: boolean } = {},
): Promise<BenchmarkResult> {
  const { logConsole = false, forceCPUSwell = false } = options;

  // Optionally capture browser console logs
  if (logConsole) {
    page.on("console", (msg) => {
      const text = msg.text();
      if (
        text.includes("[InfluenceFieldManager]") ||
        text.includes("[SwellWorker]")
      ) {
        console.log(`  [browser] ${text}`);
      }
    });
  }

  // Set CPU/GPU mode before page load via init script (runs before any JS)
  if (forceCPUSwell) {
    await page.addInitScript(() => {
      (window as any).__FORCE_CPU_SWELL = true;
    });
  }

  await page.goto("/");

  // Wait for influence field initialization to complete
  await page.waitForFunction(
    () => {
      const manager = window.DEBUG?.game?.entities?.getById(
        "influenceFieldManager",
      );
      return manager && (manager as any).isInitialized();
    },
    { timeout: 60000 },
  );

  // Get timing data
  return await page.evaluate(() => {
    const manager = window.DEBUG.game!.entities.getById(
      "influenceFieldManager",
    ) as any;
    return {
      total: manager.getPropagationTimeMs(),
      wind: manager.getWindTimeMs(),
      swell: manager.getSwellTimeMs(),
      fetch: manager.getFetchTimeMs(),
      cores: navigator.hardwareConcurrency,
      swellUsedGPU: manager.didSwellUseGPU?.() ?? false,
    };
  });
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stdDev(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const squareDiffs = values.map((v) => Math.pow(v - mean, 2));
  return Math.sqrt(squareDiffs.reduce((a, b) => a + b, 0) / values.length);
}

async function runBenchmarkSuite(
  page: import("@playwright/test").Page,
  label: string,
  forceCPUSwell = false,
) {
  const results: BenchmarkResult[] = [];

  // Run multiple iterations (log console on first run only)
  for (let i = 0; i < ITERATIONS; i++) {
    const result = await runSingleBenchmark(page, {
      logConsole: i === 0,
      forceCPUSwell,
    });
    results.push(result);
    console.log(
      `  Run ${i + 1}/${ITERATIONS}: wind=${result.wind.toFixed(0)}ms, swell=${result.swell.toFixed(0)}ms, fetch=${result.fetch.toFixed(0)}ms`,
    );
  }

  const windTimes = results.map((r) => r.wind);
  const swellTimes = results.map((r) => r.swell);
  const fetchTimes = results.map((r) => r.fetch);
  const totalTimes = results.map((r) => r.total);

  // Print results
  console.log(`\n=== ${label} ===`);
  console.log(`CPU Cores: ${results[0].cores}`);
  console.log(`Swell used GPU: ${results[0].swellUsedGPU}`);
  console.log(`Iterations: ${ITERATIONS}`);
  console.log("");
  console.log(
    `Wind:  ${median(windTimes).toFixed(0)}ms median (±${stdDev(windTimes).toFixed(0)}ms)`,
  );
  console.log(
    `Swell: ${median(swellTimes).toFixed(0)}ms median (±${stdDev(swellTimes).toFixed(0)}ms)`,
  );
  console.log(
    `Fetch: ${median(fetchTimes).toFixed(0)}ms median (±${stdDev(fetchTimes).toFixed(0)}ms)`,
  );
  console.log(
    `Total: ${median(totalTimes).toFixed(0)}ms median (±${stdDev(totalTimes).toFixed(0)}ms)`,
  );
  console.log("=".repeat(label.length + 8) + "\n");

  return { results, swellMedian: median(swellTimes) };
}

test("@benchmark propagation GPU", async ({ page }) => {
  const { swellMedian } = await runBenchmarkSuite(
    page,
    "Propagation Benchmark (GPU Swell)",
    false, // Use GPU for swell
  );

  // Sanity check - should complete
  expect(swellMedian).toBeGreaterThan(0);
});

test("@benchmark propagation CPU", async ({ page }) => {
  const { swellMedian } = await runBenchmarkSuite(
    page,
    "Propagation Benchmark (CPU Swell)",
    true, // Force CPU for swell
  );

  // Sanity check - should complete
  expect(swellMedian).toBeGreaterThan(0);
});
