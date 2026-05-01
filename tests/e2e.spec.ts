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
  await expect(mainMenu).toContainText("New Game");

  // --- Assertion: No errors during initialization ---
  expect(issues).toHaveLength(0);

  // Navigate: New Game → default level → default boat
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");

  // --- Assertion: Main menu disappears ---
  await expect(mainMenu).not.toBeVisible({ timeout: 5000 });

  // Let the game run for a few seconds to catch any post-start errors
  await page.waitForTimeout(3000);

  // --- Assertion: No errors after starting the game ---
  expect(issues).toHaveLength(0);

  // --- Assertion: MSAA live toggle works both ways ---
  // Flip MSAA off, run a few frames, flip back on, run a few more.
  await page.evaluate(() => window.DEBUG.toggleMSAA!());
  await page.waitForTimeout(500);
  await page.evaluate(() => window.DEBUG.toggleMSAA!());
  await page.waitForTimeout(500);

  expect(issues).toHaveLength(0);

  // --- Assertion: Escape in-game opens the pause menu ---
  // Wait until gameStart has actually fired (GameController sets this flag).
  await page.waitForFunction(() => window.DEBUG.gameStarted === true, {
    timeout: 30000,
  });

  await page.keyboard.press("Escape");
  const pauseMenu = page.locator(".pause-menu");
  await expect(pauseMenu).toBeVisible({ timeout: 3000 });
  await expect(pauseMenu).toContainText("Paused");

  // --- Assertion: Game is paused while the pause menu is open ---
  expect(await page.evaluate(() => window.DEBUG.game!.paused)).toBe(true);

  // --- Assertion: Navigate into Settings and see the MSAA option ---
  // Focus lands on Resume; arrow down 3 times → Settings. Enter to open.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  const settings = page.locator(".settings-panel");
  await expect(settings).toBeVisible({ timeout: 2000 });
  await expect(settings).toContainText("Antialiasing");
  // Pause menu's own button list is no longer rendered while the settings
  // submenu is active.
  await expect(pauseMenu.locator(".pause-menu__actions")).toHaveCount(0);

  // --- Assertion: Back button returns to pause menu, still paused ---
  // Settings has four focusable buttons: MSAA, Water Quality,
  // Render Resolution, Back.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(settings).not.toBeVisible({ timeout: 2000 });
  await expect(pauseMenu.locator(".pause-menu__actions")).toBeVisible();
  expect(await page.evaluate(() => window.DEBUG.game!.paused)).toBe(true);

  // --- Assertion: Escape from pause menu resumes the game ---
  await page.keyboard.press("Escape");
  await expect(pauseMenu).not.toBeVisible({ timeout: 2000 });
  expect(await page.evaluate(() => window.DEBUG.game!.paused)).toBe(false);

  expect(issues).toHaveLength(0);
});
