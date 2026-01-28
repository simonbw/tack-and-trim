/**
 * Phase 1 Integration Test: Query Infrastructure (REVISED)
 *
 * Tests the core infrastructure for world queries with new design:
 * - Tag-based query discovery (no manual registration)
 * - Three independent QueryManagers (Terrain, Water, Wind)
 * - Type-safe buffer layouts with named constants
 * - TerrainType enum (not string)
 * - One-frame latency behavior
 */

import { test, expect } from "@playwright/test";

test("Phase 1: Query managers with tag-based discovery", async ({ page }) => {
  // Navigate to game
  await page.goto("http://localhost:1234");

  // Wait for game to initialize
  await page.waitForFunction(
    () => (window as any).game && (window as any).game.isRunning,
    { timeout: 10000 },
  );

  // Test query infrastructure
  const result = await page.evaluate(async () => {
    const { game } = window as any;
    const { V } = await import("../src/core/Vector");
    const { WorldManager } = await import("../src/game/world/WorldManager");
    const { WaterQuery } = await import("../src/game/world/query/WaterQuery");
    const { TerrainQuery } = await import(
      "../src/game/world/query/TerrainQuery"
    );
    const { WindQuery } = await import("../src/game/world/query/WindQuery");
    const { TerrainType } = await import("../src/game/world/query/TerrainType");

    // Add WorldManager (creates all three query managers)
    const worldManager = new WorldManager({ baseWind: V(5, 0) });
    game.addEntity(worldManager);

    // Wait for managers to initialize
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Create test queries
    const waterQuery = new WaterQuery(() => [V(0, 0), V(100, 0)]);
    const terrainQuery = new TerrainQuery(() => [V(50, 50)]);
    const windQuery = new WindQuery(() => [V(0, 0)]);

    game.addEntity(waterQuery);
    game.addEntity(terrainQuery);
    game.addEntity(windQuery);

    // Verify tag-based discovery
    const foundWaterQueries = WaterQuery.allFromGame(game);
    const foundTerrainQueries = TerrainQuery.allFromGame(game);
    const foundWindQueries = WindQuery.allFromGame(game);

    // Frame 1: No results (one-frame latency)
    const frame1Results = {
      water: waterQuery.results.length,
      terrain: terrainQuery.results.length,
      wind: windQuery.results.length,
    };

    // Wait for results
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Frame 2: Results appear
    const frame2Results = {
      water: waterQuery.results.length,
      terrain: terrainQuery.results.length,
      wind: windQuery.results.length,
    };

    // Verify result types
    const terrainResult = terrainQuery.results[0];
    const waterResult = waterQuery.results[0];
    const windResult = windQuery.results[0];

    // Cleanup
    game.removeEntity(waterQuery);
    game.removeEntity(terrainQuery);
    game.removeEntity(windQuery);
    game.removeEntity(worldManager);

    return {
      discoveryWorks: {
        water: foundWaterQueries.length === 1,
        terrain: foundTerrainQueries.length === 1,
        wind: foundWindQueries.length === 1,
      },
      frame1Results,
      frame2Results,
      terrainTypeIsEnum: typeof terrainResult.terrainType === "number",
      terrainTypeValue: terrainResult.terrainType === TerrainType.Grass,
      waterHasAllFields:
        typeof waterResult.surfaceHeight === "number" &&
        waterResult.velocity !== undefined &&
        waterResult.normal !== undefined &&
        typeof waterResult.depth === "number",
      windHasAllFields:
        windResult.velocity !== undefined &&
        typeof windResult.speed === "number" &&
        typeof windResult.direction === "number",
    };
  });

  // Verify tag-based discovery works
  expect(result.discoveryWorks.water).toBe(true);
  expect(result.discoveryWorks.terrain).toBe(true);
  expect(result.discoveryWorks.wind).toBe(true);

  // Verify one-frame latency
  expect(result.frame1Results.water).toBe(0);
  expect(result.frame1Results.terrain).toBe(0);
  expect(result.frame1Results.wind).toBe(0);

  // Verify results appear
  expect(result.frame2Results.water).toBe(2);
  expect(result.frame2Results.terrain).toBe(1);
  expect(result.frame2Results.wind).toBe(1);

  // Verify terrainType is an enum
  expect(result.terrainTypeIsEnum).toBe(true);
  expect(result.terrainTypeValue).toBe(true);

  // Verify result structures
  expect(result.waterHasAllFields).toBe(true);
  expect(result.windHasAllFields).toBe(true);

  console.log("Phase 1 tests passed!");
});
