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

test("game initializes, shows main menu, and starts without errors", async ({
  page,
}) => {
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

  // --- Assertion: Game loop is running ---
  const tickCount = await page.evaluate(() => window.DEBUG.game!.ticknumber);
  expect(tickCount).toBeGreaterThan(0);

  // --- Assertion: Main menu is displayed ---
  const mainMenu = page.locator(".main-menu");
  await expect(mainMenu).toBeVisible({ timeout: 30000 });
  await expect(mainMenu).toContainText("Tack & Trim");
  await expect(mainMenu).toContainText("Press Enter to Start");

  // --- Assertion: No errors during initialization ---
  expect(issues).toHaveLength(0);

  // Press Enter to start the game
  await page.keyboard.press("Enter");

  // --- Assertion: Main menu disappears ---
  await expect(mainMenu).not.toBeVisible({ timeout: 5000 });

  // Let the game run for a few seconds to catch any post-start errors
  await page.waitForTimeout(3000);

  // --- Assertion: No errors after starting the game ---
  expect(issues).toHaveLength(0);
});
