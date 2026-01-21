/**
 * Fetch map computation algorithm.
 *
 * Fetch is the distance over open water that wind can blow to build up waves.
 * For each grid cell and direction, we compute how far upwind the water extends
 * before hitting land or reaching the maximum fetch distance.
 *
 * This is used by the wave generation system to determine local wave heights
 * based on wind speed and fetch distance.
 */

import { V2d } from "../../../../core/Vector";
import { InfluenceFieldGrid } from "../InfluenceFieldGrid";
import type { InfluenceGridConfig } from "../InfluenceFieldTypes";
import { TerrainSampler } from "./TerrainSampler";
import { getDirectionVector, precomputeWaterMask } from "./PropagationCore";

/**
 * Input parameters for fetch map computation.
 */
export interface FetchComputationInput {
  /** Terrain sampler for land/water queries */
  terrain: TerrainSampler;
  /** Grid configuration */
  gridConfig: InfluenceGridConfig;
  /** Maximum fetch distance in ft (default: 50000 ft ~15km) */
  maxFetch?: number;
  /** Step size for ray marching in ft (default: cellSize / 2) */
  stepSize?: number;
}

/** Default maximum fetch distance (~15km) */
const DEFAULT_MAX_FETCH = 50000;

/**
 * Compute the fetch map for all directions.
 *
 * For each grid cell and direction:
 * - If the cell is on land, fetch = 0
 * - Otherwise, ray-march upwind until hitting land or max distance
 * - Store the distance traveled
 *
 * @param input - Input parameters
 * @returns Influence field grid with fetch distances (in ft) for all directions
 */
export function computeFetchMap(
  input: FetchComputationInput,
): InfluenceFieldGrid<number> {
  const { terrain, gridConfig } = input;
  const maxFetch = input.maxFetch ?? DEFAULT_MAX_FETCH;
  const stepSize = input.stepSize ?? gridConfig.cellSize / 2;
  const { directionCount } = gridConfig;

  // Create output grid
  const grid = new InfluenceFieldGrid<number>(gridConfig, () => 0);

  // Pre-compute water mask
  const waterMask = precomputeWaterMask(terrain, gridConfig);

  // Process each direction
  for (let dir = 0; dir < directionCount; dir++) {
    // Direction vector pointing FROM the wind source (upwind direction to march)
    const sourceDir = getDirectionVector(dir, directionCount);
    // We want to march in the opposite direction (upwind)
    const upwindDir = sourceDir.negate();

    computeFetchForDirection(
      dir,
      upwindDir,
      waterMask,
      terrain,
      gridConfig,
      maxFetch,
      stepSize,
      grid,
    );
  }

  return grid;
}

/**
 * Compute fetch for a single direction.
 */
function computeFetchForDirection(
  dirIndex: number,
  upwindDir: V2d,
  waterMask: boolean[],
  terrain: TerrainSampler,
  gridConfig: InfluenceGridConfig,
  maxFetch: number,
  stepSize: number,
  grid: InfluenceFieldGrid<number>,
): void {
  const { cellsX, cellsY, cellSize, originX, originY } = gridConfig;

  for (let y = 0; y < cellsY; y++) {
    for (let x = 0; x < cellsX; x++) {
      const idx = y * cellsX + x;

      // Land cells have zero fetch
      if (!waterMask[idx]) {
        grid.setCellDirect(x, y, dirIndex, 0);
        continue;
      }

      // Start at cell center
      const startX = originX + (x + 0.5) * cellSize;
      const startY = originY + (y + 0.5) * cellSize;

      // Ray-march upwind
      const fetch = computeFetchRayMarch(
        startX,
        startY,
        upwindDir,
        terrain,
        maxFetch,
        stepSize,
      );

      grid.setCellDirect(x, y, dirIndex, fetch);
    }
  }
}

/**
 * Ray-march from a starting point in the upwind direction until hitting land.
 *
 * @param startX - Starting X coordinate
 * @param startY - Starting Y coordinate
 * @param upwindDir - Unit vector pointing upwind (opposite to wind direction)
 * @param terrain - Terrain sampler for land checks
 * @param maxFetch - Maximum distance to march
 * @param stepSize - Distance per step
 * @returns Fetch distance in ft
 */
function computeFetchRayMarch(
  startX: number,
  startY: number,
  upwindDir: V2d,
  terrain: TerrainSampler,
  maxFetch: number,
  stepSize: number,
): number {
  let distance = 0;
  let px = startX;
  let py = startY;

  const stepX = upwindDir.x * stepSize;
  const stepY = upwindDir.y * stepSize;

  while (distance < maxFetch) {
    // Take a step upwind
    px += stepX;
    py += stepY;
    distance += stepSize;

    // Check if we've hit land
    if (terrain.isLand(new V2d(px, py))) {
      // Return distance minus one step (we want distance to last water point)
      return Math.max(0, distance - stepSize);
    }
  }

  // Reached max fetch without hitting land
  return maxFetch;
}
