import { test, expect } from "@playwright/test";

test("boat editor initializes and runs without errors", async ({ page }) => {
  const issues: string[] = [];
  page.on("pageerror", (err) => issues.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning")
      issues.push(msg.text());
  });

  await page.goto("/boat-editor.html");

  // Wait for the editor's game loop to initialize
  await page.waitForFunction(
    () => window.BOAT_EDITOR_DEBUG?.game && window.BOAT_EDITOR_DEBUG?.editor,
    { timeout: 30000 },
  );

  // --- Assertion: Game loop is running ---
  const tickCount = await page.evaluate(
    () => window.BOAT_EDITOR_DEBUG.game!.ticknumber,
  );
  expect(tickCount).toBeGreaterThan(0);

  // --- Assertion: Swapping presets reconstructs the preview Boat cleanly ---
  // The preview constructs a real Boat instance per config, so cycling
  // through presets exercises every boat-component constructor.
  const presets = [
    "Shaff S-20",
    "BHC Daysailer",
    "BHC Expedition",
    "Maestro Etude",
    "Maestro Opus",
    "Shaff S-7",
  ];
  for (const name of presets) {
    await page.evaluate(
      (n) => window.BOAT_EDITOR_DEBUG.editor!.loadPreset(n),
      name,
    );
  }

  // Let it run briefly to catch any post-init or post-swap errors
  await page.waitForTimeout(1000);

  // --- Assertion: No errors during startup or preset cycling ---
  expect(issues).toHaveLength(0);
});
