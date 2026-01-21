/**
 * Swell influence field propagation algorithm.
 *
 * Computes how terrain affects wave propagation from each of 16 directions.
 * Similar to wind propagation but with higher lateral spread (diffraction)
 * and tracking of arrival direction as waves bend around obstacles.
 */

import { V2d } from "../../../../core/Vector";
import { InfluenceFieldGrid } from "../InfluenceFieldGrid";
import type {
  InfluenceGridConfig,
  SwellInfluence,
} from "../InfluenceFieldTypes";
import { WavelengthClass } from "../InfluenceFieldTypes";
import {
  LONG_SWELL_PROPAGATION_CONFIG,
  SHORT_CHOP_PROPAGATION_CONFIG,
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
 * Input parameters for swell influence field computation.
 */
export interface SwellPropagationInput {
  /** Terrain sampler for land/water queries */
  terrain: TerrainSampler;
  /** Grid configuration */
  gridConfig: InfluenceGridConfig;
  /** Wavelength class (affects diffraction amount) */
  wavelengthClass: WavelengthClass;
  /** Propagation configuration (defaults based on wavelength class) */
  propagationConfig?: PropagationConfig;
}

/**
 * Get default propagation config for a wavelength class.
 */
function getDefaultConfig(wavelengthClass: WavelengthClass): PropagationConfig {
  switch (wavelengthClass) {
    case WavelengthClass.LongSwell:
      return LONG_SWELL_PROPAGATION_CONFIG;
    case WavelengthClass.ShortChop:
      return SHORT_CHOP_PROPAGATION_CONFIG;
  }
}

/**
 * Compute the swell influence field for a single wavelength class.
 *
 * For each of 16 directions:
 * 1. Initialize energy=1 at upwind boundary, 0 for land cells
 * 2. Iterate until convergence, propagating energy with higher lateral spread than wind
 * 3. Track weighted arrival direction as waves bend around obstacles
 * 4. Store results in grid
 *
 * @param input - Input parameters
 * @returns Influence field grid with swell effects for all directions
 */
export function computeSwellInfluenceField(
  input: SwellPropagationInput,
): InfluenceFieldGrid<SwellInfluence> {
  const { terrain, gridConfig, wavelengthClass } = input;
  const config = input.propagationConfig ?? getDefaultConfig(wavelengthClass);
  const { directionCount } = gridConfig;

  // Create output grid
  const grid = new InfluenceFieldGrid<SwellInfluence>(gridConfig, () => ({
    energyFactor: 1.0,
    arrivalDirection: 0,
  }));

  // Pre-compute water mask (shared across all directions)
  const waterMask = precomputeWaterMask(terrain, gridConfig);

  // Process each source direction
  for (let dir = 0; dir < directionCount; dir++) {
    const sourceDir = getDirectionVector(dir, directionCount);
    const sourceAngle = (dir / directionCount) * Math.PI * 2;

    const result = propagateSwellForDirection(
      sourceDir,
      sourceAngle,
      dir,
      waterMask,
      gridConfig,
      config,
      grid,
    );

    if (!result.converged) {
      console.warn(
        `Swell propagation dir=${dir} did not converge: ${result.iterations} iterations, maxChange=${result.maxChange.toFixed(4)}`,
      );
    }
  }

  return grid;
}

/**
 * Compute swell influence fields for all wavelength classes.
 *
 * @param terrain - Terrain sampler for land/water queries
 * @param gridConfig - Grid configuration
 * @returns Array of influence field grids, indexed by WavelengthClass
 */
export function computeAllSwellInfluenceFields(
  terrain: TerrainSampler,
  gridConfig: InfluenceGridConfig,
): InfluenceFieldGrid<SwellInfluence>[] {
  return [
    computeSwellInfluenceField({
      terrain,
      gridConfig,
      wavelengthClass: WavelengthClass.LongSwell,
    }),
    computeSwellInfluenceField({
      terrain,
      gridConfig,
      wavelengthClass: WavelengthClass.ShortChop,
    }),
  ];
}

/**
 * Propagate swell energy for a single source direction.
 */
function propagateSwellForDirection(
  sourceDir: V2d,
  sourceAngle: number,
  dirIndex: number,
  waterMask: boolean[],
  gridConfig: InfluenceGridConfig,
  config: PropagationConfig,
  grid: InfluenceFieldGrid<SwellInfluence>,
): PropagationResult {
  const { cellsX, cellsY, cellSize, originX, originY } = gridConfig;
  const cellCount = cellsX * cellsY;

  // Working arrays for current and next iteration energy
  const energy = new Float32Array(cellCount);
  const nextEnergy = new Float32Array(cellCount);

  // Weighted direction accumulator for arrival direction calculation
  const arrivalDirX = new Float32Array(cellCount);
  const arrivalDirY = new Float32Array(cellCount);

  // Initialize energy: 1.0 at upwind boundary water cells, 0 elsewhere
  for (let y = 0; y < cellsY; y++) {
    for (let x = 0; x < cellsX; x++) {
      const idx = y * cellsX + x;
      if (!waterMask[idx]) {
        energy[idx] = 0;
      } else if (isUpwindBoundary(x, y, cellsX, cellsY, sourceDir)) {
        energy[idx] = 1.0;
        // Initialize arrival direction to source direction at boundary
        arrivalDirX[idx] = sourceDir.x;
        arrivalDirY[idx] = sourceDir.y;
      } else {
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
    nextEnergy.set(energy);

    for (let y = 0; y < cellsY; y++) {
      for (let x = 0; x < cellsX; x++) {
        const idx = y * cellsX + x;

        if (!waterMask[idx]) continue;
        if (isUpwindBoundary(x, y, cellsX, cellsY, sourceDir)) continue;

        const currentPos = new V2d(
          originX + (x + 0.5) * cellSize,
          originY + (y + 0.5) * cellSize,
        );

        let totalEnergy = 0;
        let totalWeight = 0;
        let weightedDirX = 0;
        let weightedDirY = 0;

        for (const [dx, dy] of NEIGHBOR_OFFSETS) {
          const nx = x + dx;
          const ny = y + dy;

          if (nx < 0 || nx >= cellsX || ny < 0 || ny >= cellsY) continue;

          const neighborIdx = ny * cellsX + nx;
          if (!waterMask[neighborIdx]) continue;

          const neighborPos = new V2d(
            originX + (nx + 0.5) * cellSize,
            originY + (ny + 0.5) * cellSize,
          );

          const weight = computeFlowWeight(
            neighborPos,
            currentPos,
            sourceDir,
            config,
          );

          if (weight > 0) {
            totalWeight += weight;
            totalEnergy += energy[neighborIdx] * weight;

            // Track arrival direction (weighted by energy contribution)
            const contribution = energy[neighborIdx] * weight;
            const flowDir = currentPos.sub(neighborPos).inormalize();
            weightedDirX += flowDir.x * contribution;
            weightedDirY += flowDir.y * contribution;
          }
        }

        let newEnergy = 0;
        if (totalWeight > 0) {
          newEnergy = clamp01(totalEnergy / totalWeight);
        }

        nextEnergy[idx] = newEnergy;
        maxChange = Math.max(maxChange, Math.abs(newEnergy - energy[idx]));

        // Store weighted direction for arrival calculation
        arrivalDirX[idx] = weightedDirX;
        arrivalDirY[idx] = weightedDirY;
      }
    }

    energy.set(nextEnergy);
    iterations++;
  }

  // Compute final values and store in grid
  for (let y = 0; y < cellsY; y++) {
    for (let x = 0; x < cellsX; x++) {
      const idx = y * cellsX + x;

      if (!waterMask[idx]) {
        grid.setCellDirect(x, y, dirIndex, {
          energyFactor: 0,
          arrivalDirection: sourceAngle,
        });
        continue;
      }

      const energyFactor = energy[idx];

      // Compute arrival direction from weighted incoming directions
      let arrivalDirection = sourceAngle;
      const dirMag = Math.sqrt(
        arrivalDirX[idx] * arrivalDirX[idx] +
          arrivalDirY[idx] * arrivalDirY[idx],
      );
      if (dirMag > 0.001) {
        arrivalDirection = Math.atan2(
          arrivalDirY[idx] / dirMag,
          arrivalDirX[idx] / dirMag,
        );
      }

      grid.setCellDirect(x, y, dirIndex, {
        energyFactor,
        arrivalDirection,
      });
    }
  }

  return {
    iterations,
    maxChange,
    converged: maxChange <= config.convergenceThreshold,
  };
}
