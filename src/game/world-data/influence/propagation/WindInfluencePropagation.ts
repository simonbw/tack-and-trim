/**
 * Wind influence field propagation algorithm.
 *
 * Computes how terrain affects wind flow from each of 16 directions.
 * Uses iterative relaxation to propagate wind energy from upwind boundaries
 * through the grid, accounting for blocking by land and wake effects.
 */

import { V2d } from "../../../../core/Vector";
import { InfluenceFieldGrid } from "../InfluenceFieldGrid";
import type {
  InfluenceGridConfig,
  WindInfluence,
} from "../InfluenceFieldTypes";
import {
  WIND_PROPAGATION_CONFIG,
  type PropagationConfig,
} from "../PropagationConfig";
import { TerrainSampler } from "./TerrainSampler";
import {
  type PropagationResult,
  getDirectionVector,
  precomputeWaterMask,
  computeFlowWeight,
  NEIGHBOR_OFFSETS,
  isUpwindBoundary,
  clamp01,
} from "./PropagationCore";

/**
 * Input parameters for wind influence field computation.
 */
export interface WindPropagationInput {
  /** Terrain sampler for land/water queries */
  terrain: TerrainSampler;
  /** Grid configuration */
  gridConfig: InfluenceGridConfig;
  /** Propagation configuration (defaults to WIND_PROPAGATION_CONFIG) */
  propagationConfig?: PropagationConfig;
}

/**
 * Compute the complete wind influence field for all directions.
 *
 * For each of 16 directions:
 * 1. Initialize energy=1 at upwind boundary, 0 for land cells
 * 2. Iterate until convergence, propagating energy from upwind neighbors
 * 3. Compute turbulence from energy gradients
 * 4. Store results in grid
 *
 * @param input - Input parameters
 * @returns Influence field grid with wind effects for all directions
 */
export function computeWindInfluenceField(
  input: WindPropagationInput,
): InfluenceFieldGrid<WindInfluence> {
  const { terrain, gridConfig } = input;
  const config = input.propagationConfig ?? WIND_PROPAGATION_CONFIG;
  const { directionCount } = gridConfig;

  // Create output grid
  const grid = new InfluenceFieldGrid<WindInfluence>(gridConfig, () => ({
    speedFactor: 1.0,
    directionOffset: 0,
    turbulence: 0,
  }));

  // Pre-compute water mask (shared across all directions)
  const waterMask = precomputeWaterMask(terrain, gridConfig);

  // Process each source direction
  for (let dir = 0; dir < directionCount; dir++) {
    const sourceDir = getDirectionVector(dir, directionCount);
    const result = propagateWindForDirection(
      sourceDir,
      dir,
      waterMask,
      gridConfig,
      config,
      grid,
    );

    // Log convergence status for debugging (could be removed in production)
    if (!result.converged) {
      console.warn(
        `Wind propagation dir=${dir} did not converge: ${result.iterations} iterations, maxChange=${result.maxChange.toFixed(4)}`,
      );
    }
  }

  return grid;
}

/**
 * Propagate wind energy for a single source direction.
 */
function propagateWindForDirection(
  sourceDir: V2d,
  dirIndex: number,
  waterMask: boolean[],
  gridConfig: InfluenceGridConfig,
  config: PropagationConfig,
  grid: InfluenceFieldGrid<WindInfluence>,
): PropagationResult {
  const { cellsX, cellsY, cellSize, originX, originY } = gridConfig;
  const cellCount = cellsX * cellsY;

  // Working arrays for current and next iteration energy
  const energy = new Float32Array(cellCount);
  const nextEnergy = new Float32Array(cellCount);

  // Weighted direction accumulator for deflection calculation
  const deflectionX = new Float32Array(cellCount);
  const deflectionY = new Float32Array(cellCount);

  // Initialize energy: 1.0 at upwind boundary water cells, 0 elsewhere
  for (let y = 0; y < cellsY; y++) {
    for (let x = 0; x < cellsX; x++) {
      const idx = y * cellsX + x;
      if (!waterMask[idx]) {
        // Land cell: no wind energy
        energy[idx] = 0;
      } else if (isUpwindBoundary(x, y, cellsX, cellsY, sourceDir)) {
        // Upwind boundary: full energy
        energy[idx] = 1.0;
      } else {
        // Interior water: start at 0, will be filled by propagation
        energy[idx] = 0;
      }
    }
  }

  // Iterative relaxation
  let iterations = 0;
  let maxChange = Infinity;

  while (
    iterations < config.maxIterations &&
    maxChange > config.convergenceThreshold
  ) {
    maxChange = 0;

    // Copy current energy to next (boundary cells stay fixed)
    nextEnergy.set(energy);

    // Process each water cell
    for (let y = 0; y < cellsY; y++) {
      for (let x = 0; x < cellsX; x++) {
        const idx = y * cellsX + x;

        // Skip land cells
        if (!waterMask[idx]) continue;

        // Skip upwind boundary cells (they stay at 1.0)
        if (isUpwindBoundary(x, y, cellsX, cellsY, sourceDir)) continue;

        // Current cell world position
        const currentPos = new V2d(
          originX + (x + 0.5) * cellSize,
          originY + (y + 0.5) * cellSize,
        );

        // Accumulate energy from all neighbors
        let totalEnergy = 0;
        let totalWeight = 0;
        let weightedDirX = 0;
        let weightedDirY = 0;

        for (const [dx, dy] of NEIGHBOR_OFFSETS) {
          const nx = x + dx;
          const ny = y + dy;

          // Skip out-of-bounds
          if (nx < 0 || nx >= cellsX || ny < 0 || ny >= cellsY) continue;

          const neighborIdx = ny * cellsX + nx;

          // Skip land neighbors
          if (!waterMask[neighborIdx]) continue;

          // Neighbor world position
          const neighborPos = new V2d(
            originX + (nx + 0.5) * cellSize,
            originY + (ny + 0.5) * cellSize,
          );

          // Compute flow weight
          const weight = computeFlowWeight(
            neighborPos,
            currentPos,
            sourceDir,
            config,
          );
          if (weight > 0) {
            totalWeight += weight;
            totalEnergy += energy[neighborIdx] * weight;

            // Track direction for deflection (weighted by energy contribution)
            const contribution = energy[neighborIdx] * weight;
            const flowDir = currentPos.sub(neighborPos).inormalize();
            weightedDirX += flowDir.x * contribution;
            weightedDirY += flowDir.y * contribution;
          }
        }

        // Compute new energy
        let newEnergy = 0;
        if (totalWeight > 0) {
          newEnergy = clamp01(totalEnergy / totalWeight);
        }

        nextEnergy[idx] = newEnergy;
        maxChange = Math.max(maxChange, Math.abs(newEnergy - energy[idx]));

        // Store weighted direction for deflection
        deflectionX[idx] = weightedDirX;
        deflectionY[idx] = weightedDirY;
      }
    }

    // Swap buffers
    energy.set(nextEnergy);
    iterations++;
  }

  // Compute final values and store in grid
  for (let y = 0; y < cellsY; y++) {
    for (let x = 0; x < cellsX; x++) {
      const idx = y * cellsX + x;

      if (!waterMask[idx]) {
        // Land cells: no wind
        grid.setCellDirect(x, y, dirIndex, {
          speedFactor: 0,
          directionOffset: 0,
          turbulence: 0,
        });
        continue;
      }

      const speedFactor = energy[idx];

      // Compute direction offset from weighted incoming directions
      let directionOffset = 0;
      const dirMag = Math.sqrt(
        deflectionX[idx] * deflectionX[idx] +
          deflectionY[idx] * deflectionY[idx],
      );
      if (dirMag > 0.001) {
        const actualDir = new V2d(
          deflectionX[idx] / dirMag,
          deflectionY[idx] / dirMag,
        );
        // Direction offset is angle difference from source direction
        const actualAngle = Math.atan2(actualDir.y, actualDir.x);
        const sourceAngle = Math.atan2(sourceDir.y, sourceDir.x);
        directionOffset = actualAngle - sourceAngle;
        // Normalize to [-π, π]
        while (directionOffset > Math.PI) directionOffset -= Math.PI * 2;
        while (directionOffset < -Math.PI) directionOffset += Math.PI * 2;
      }

      // Compute turbulence from energy gradient
      const turbulence = computeTurbulence(
        x,
        y,
        idx,
        energy,
        waterMask,
        cellsX,
        cellsY,
      );

      grid.setCellDirect(x, y, dirIndex, {
        speedFactor,
        directionOffset,
        turbulence,
      });
    }
  }

  return {
    iterations,
    maxChange,
    converged: maxChange <= config.convergenceThreshold,
  };
}

/**
 * Compute turbulence at a cell based on energy gradient.
 *
 * Turbulence is high where:
 * - Energy drops sharply (wake/lee zones)
 * - Cell is just downwind of land
 */
function computeTurbulence(
  x: number,
  y: number,
  idx: number,
  energy: Float32Array,
  waterMask: boolean[],
  cellsX: number,
  cellsY: number,
): number {
  const currentEnergy = energy[idx];
  let maxDrop = 0;
  let hasLandNeighbor = false;

  // Check all neighbors for energy drops and land proximity
  for (const [dx, dy] of NEIGHBOR_OFFSETS) {
    const nx = x + dx;
    const ny = y + dy;

    if (nx < 0 || nx >= cellsX || ny < 0 || ny >= cellsY) continue;

    const neighborIdx = ny * cellsX + nx;

    if (!waterMask[neighborIdx]) {
      hasLandNeighbor = true;
      continue;
    }

    // Track largest energy drop from neighbors
    const neighborEnergy = energy[neighborIdx];
    if (neighborEnergy > currentEnergy) {
      maxDrop = Math.max(maxDrop, neighborEnergy - currentEnergy);
    }
  }

  // Base turbulence from energy gradient
  let turbulence = maxDrop * 2; // Scale factor for sensitivity

  // Add turbulence for cells adjacent to land (wake effect)
  if (hasLandNeighbor && currentEnergy < 0.8) {
    turbulence += 0.3;
  }

  return clamp01(turbulence);
}
