/**
 * Phase 1 Integration Test: Query Infrastructure
 *
 * Simple test to verify Phase 1 infrastructure doesn't crash the game.
 * Tests that WorldManager and QueryManagers can be initialized without errors.
 */

import { test, expect } from "@playwright/test";

test("Phase 1: Query infrastructure initializes without errors", async ({
  page,
}) => {
  // Collect any errors during initialization
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  await page.goto("/");

  // Wait for game to initialize
  await page.waitForFunction(() => window.DEBUG?.game, { timeout: 10000 });

  // Let the game run for a bit to ensure query managers tick
  await page.waitForTimeout(500);

  // Verify query managers exist
  const managersExist = await page.evaluate(() => {
    const game = window.DEBUG.game!;
    const terrain = game.entities.getById("terrainQueryManager");
    const water = game.entities.getById("waterQueryManager");
    const wind = game.entities.getById("windQueryManager");

    return {
      terrain: terrain !== null,
      water: water !== null,
      wind: wind !== null,
    };
  });

  // Assert no errors occurred
  expect(errors).toHaveLength(0);

  // Assert all three query managers were created
  expect(managersExist.terrain).toBe(true);
  expect(managersExist.water).toBe(true);
  expect(managersExist.wind).toBe(true);

  console.log("✅ Phase 1 infrastructure initialized successfully");
});
