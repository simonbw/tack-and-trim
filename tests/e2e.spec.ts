import { test, expect } from "@playwright/test";

test("game starts and runs without errors", async ({ page }) => {
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

  // Verify game loop ran
  const tickCount = await page.evaluate(() => window.DEBUG.game!.ticknumber);
  expect(tickCount).toBeGreaterThan(0);

  // Verify no errors or warnings occurred
  expect(issues).toHaveLength(0);
});

test("influence field propagation completes in reasonable time", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForFunction(() => window.DEBUG?.game, { timeout: 30000 });

  const propagationTime = await page.evaluate(() => {
    const manager = window.DEBUG.game!.entities.getById(
      "influenceFieldManager",
    );
    return (manager as any).getPropagationTimeMs();
  });

  // Allow up to 3 seconds for propagation (current dev config takes ~1s)
  expect(propagationTime).toBeLessThan(3000);
  console.log(`Propagation time: ${propagationTime}ms`);
});
