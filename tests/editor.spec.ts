import { test, expect } from "@playwright/test";

test("terrain editor initializes and runs without errors", async ({ page }) => {
  const issues: string[] = [];
  page.on("pageerror", (err) => issues.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      // Wave physics warning is expected in the editor (no prebuilt mesh data)
      if (msg.text().includes("wave physics will be inactive")) return;
      issues.push(msg.text());
    }
  });

  await page.goto("/editor.html");

  // Wait for the editor's game loop to initialize
  await page.waitForFunction(() => window.EDITOR_DEBUG?.game, {
    timeout: 30000,
  });

  // --- Assertion: Game loop is running ---
  const tickCount = await page.evaluate(
    () => window.EDITOR_DEBUG.game!.ticknumber,
  );
  expect(tickCount).toBeGreaterThan(0);

  // Let it run briefly to catch any post-init errors
  await page.waitForTimeout(2000);

  // --- Assertion: No errors during startup ---
  expect(issues).toHaveLength(0);
});
