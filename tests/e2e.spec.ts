import { test, expect } from "@playwright/test";

/**
 * E2E Testing Philosophy
 *
 * E2E tests are slow due to browser startup and game initialization overhead.
 * Rather than writing many small isolated tests (unit test style), we prefer
 * fewer tests that each make multiple assertions. This keeps the test suite
 * fast while still providing good coverage.
 *
 * See tests/CLAUDE.md for more details.
 */

test("game initializes and runs correctly", async ({ page }) => {
  // Collect any errors/warnings during the test
  const issues: string[] = [];
  page.on("pageerror", (err) => issues.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning")
      issues.push(msg.text());
  });

  await page.goto("/");

  // Wait for game to initialize (DEBUG.game exists)
  await page.waitForFunction(() => window.DEBUG?.game, { timeout: 30000 });

  // Let the game run for 2 seconds
  await page.waitForTimeout(2000);

  // --- Assertion: Game loop is running ---
  const tickCount = await page.evaluate(() => window.DEBUG.game!.ticknumber);
  expect(tickCount).toBeGreaterThan(0);

  // --- Assertion: No errors or warnings occurred ---
  expect(issues).toHaveLength(0);

  // --- Assertion: Influence field manager initializes successfully ---
  // Wait for async initialization to complete (propagation can take a few seconds)
  await page.waitForFunction(
    () => {
      const manager = window.DEBUG.game!.entities.getById(
        "influenceFieldManager",
      );
      return (manager as any)?.isInitialized() === true;
    },
    { timeout: 30000 },
  );
});
