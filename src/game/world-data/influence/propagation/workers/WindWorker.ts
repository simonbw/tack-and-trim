/**
 * Wind Propagation Web Worker
 *
 * Computes how terrain affects wind flow using an iterative relaxation algorithm.
 * Runs in a separate thread for parallel computation across multiple directions.
 *
 * Message Protocol:
 * - Receives: WindWorkerRequest with directions, grid config, and water mask
 * - Sends: WindWorkerProgress after each direction, WindWorkerResult when complete
 */

/// <reference lib="webworker" />

// ============================================================================
// Types
// ============================================================================

/**
 * Serializable grid configuration (no class instances).
 */
export interface SerializableGridConfig {
  cellSize: number;
  cellsX: number;
  cellsY: number;
  originX: number;
  originY: number;
  directionCount: number;
}

/**
 * Serializable propagation configuration.
 */
export interface SerializablePropagationConfig {
  directFlowFactor: number;
  lateralSpreadFactor: number;
  decayFactor: number;
  maxIterations: number;
  convergenceThreshold: number;
}

/**
 * Request from main thread to compute wind propagation.
 */
export interface WindWorkerRequest {
  type: "compute";
  batchId: number;
  directions: number[];
  gridConfig: SerializableGridConfig;
  propagationConfig: SerializablePropagationConfig;
  waterMask: Uint8Array;
  sourceAngles: number[];
}

/**
 * Progress update from worker to main thread.
 */
export interface WindWorkerProgress {
  type: "progress";
  batchId: number;
  completedDirection: number;
  batchProgress: number;
}

/**
 * Result from worker to main thread with computed data.
 */
export interface WindWorkerResult {
  type: "result";
  batchId: number;
  directions: number[];
  windData: Float32Array;
}

/**
 * Error from worker to main thread.
 */
export interface WindWorkerError {
  type: "error";
  batchId: number;
  message: string;
}

export type WindWorkerOutgoingMessage =
  | WindWorkerProgress
  | WindWorkerResult
  | WindWorkerError;

// ============================================================================
// Constants
// ============================================================================

const NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

// ============================================================================
// Core Algorithm
// ============================================================================

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Result from computeFlowWeight with weight and normalized direction.
 */
interface FlowResult {
  weight: number;
  flowDirX: number;
  flowDirY: number;
}

// Reusable result object to avoid allocations in hot loop
const flowResult: FlowResult = { weight: 0, flowDirX: 0, flowDirY: 0 };

function isUpwindBoundary(
  x: number,
  y: number,
  cellsX: number,
  cellsY: number,
  sourceDirX: number,
  sourceDirY: number,
): boolean {
  if (sourceDirX > 0.1 && x === 0) return true;
  if (sourceDirX < -0.1 && x === cellsX - 1) return true;
  if (sourceDirY > 0.1 && y === 0) return true;
  if (sourceDirY < -0.1 && y === cellsY - 1) return true;
  return false;
}

function computeFlowWeight(
  neighborX: number,
  neighborY: number,
  currentX: number,
  currentY: number,
  sourceDirX: number,
  sourceDirY: number,
  config: SerializablePropagationConfig,
): FlowResult {
  let flowDirX = currentX - neighborX;
  let flowDirY = currentY - neighborY;

  const flowMag = Math.sqrt(flowDirX * flowDirX + flowDirY * flowDirY);
  if (flowMag < 0.0001) {
    flowResult.weight = 0;
    flowResult.flowDirX = 0;
    flowResult.flowDirY = 0;
    return flowResult;
  }
  flowDirX /= flowMag;
  flowDirY /= flowMag;

  const alignment = flowDirX * sourceDirX + flowDirY * sourceDirY;

  if (alignment <= 0) {
    flowResult.weight = 0;
    flowResult.flowDirX = 0;
    flowResult.flowDirY = 0;
    return flowResult;
  }

  const directWeight = alignment * config.directFlowFactor;
  const lateralWeight = (1 - alignment) * config.lateralSpreadFactor;

  flowResult.weight = (directWeight + lateralWeight) * config.decayFactor;
  flowResult.flowDirX = flowDirX;
  flowResult.flowDirY = flowDirY;
  return flowResult;
}

function computeTurbulence(
  x: number,
  y: number,
  idx: number,
  energy: Float32Array,
  waterMask: Uint8Array,
  cellsX: number,
  cellsY: number,
): number {
  const currentEnergy = energy[idx];
  let maxDrop = 0;
  let hasLandNeighbor = false;

  for (const [dx, dy] of NEIGHBOR_OFFSETS) {
    const nx = x + dx;
    const ny = y + dy;

    if (nx < 0 || nx >= cellsX || ny < 0 || ny >= cellsY) continue;

    const neighborIdx = ny * cellsX + nx;

    if (waterMask[neighborIdx] === 0) {
      hasLandNeighbor = true;
      continue;
    }

    const neighborEnergy = energy[neighborIdx];
    if (neighborEnergy > currentEnergy) {
      maxDrop = Math.max(maxDrop, neighborEnergy - currentEnergy);
    }
  }

  let turbulence = maxDrop * 2;

  if (hasLandNeighbor && currentEnergy < 0.8) {
    turbulence += 0.3;
  }

  return clamp01(turbulence);
}

function propagateWindForDirection(
  dirIndex: number,
  sourceAngle: number,
  waterMask: Uint8Array,
  gridConfig: SerializableGridConfig,
  propagationConfig: SerializablePropagationConfig,
  outWindData: Float32Array,
): { converged: boolean; iterations: number; maxChange: number } {
  const { cellsX, cellsY, cellSize, originX, originY } = gridConfig;
  const cellCount = cellsX * cellsY;
  const dirOffset = dirIndex * cellCount * 4;

  const sourceDirX = Math.cos(sourceAngle);
  const sourceDirY = Math.sin(sourceAngle);

  const energy = new Float32Array(cellCount);
  const nextEnergy = new Float32Array(cellCount);
  const deflectionX = new Float32Array(cellCount);
  const deflectionY = new Float32Array(cellCount);

  // Pre-compute cell center positions (static, computed once)
  const cellCentersX = new Float32Array(cellCount);
  const cellCentersY = new Float32Array(cellCount);
  for (let y = 0; y < cellsY; y++) {
    for (let x = 0; x < cellsX; x++) {
      const idx = y * cellsX + x;
      cellCentersX[idx] = originX + (x + 0.5) * cellSize;
      cellCentersY[idx] = originY + (y + 0.5) * cellSize;
    }
  }

  // Initialize energy
  for (let y = 0; y < cellsY; y++) {
    for (let x = 0; x < cellsX; x++) {
      const idx = y * cellsX + x;
      if (waterMask[idx] === 0) {
        energy[idx] = 0;
      } else if (
        isUpwindBoundary(x, y, cellsX, cellsY, sourceDirX, sourceDirY)
      ) {
        energy[idx] = 1.0;
      } else {
        energy[idx] = 0;
      }
    }
  }

  // Iterative relaxation
  let iterations = 0;
  let maxChange = Infinity;

  while (
    iterations < propagationConfig.maxIterations &&
    maxChange > propagationConfig.convergenceThreshold
  ) {
    maxChange = 0;
    nextEnergy.set(energy);

    for (let y = 0; y < cellsY; y++) {
      for (let x = 0; x < cellsX; x++) {
        const idx = y * cellsX + x;

        if (waterMask[idx] === 0) continue;
        if (isUpwindBoundary(x, y, cellsX, cellsY, sourceDirX, sourceDirY))
          continue;

        // Use pre-computed cell centers
        const currentPosX = cellCentersX[idx];
        const currentPosY = cellCentersY[idx];

        let totalEnergy = 0;
        let totalWeight = 0;
        let weightedDirX = 0;
        let weightedDirY = 0;

        for (const [dx, dy] of NEIGHBOR_OFFSETS) {
          const nx = x + dx;
          const ny = y + dy;

          if (nx < 0 || nx >= cellsX || ny < 0 || ny >= cellsY) continue;

          const neighborIdx = ny * cellsX + nx;
          if (waterMask[neighborIdx] === 0) continue;

          // Use pre-computed cell centers
          const neighborPosX = cellCentersX[neighborIdx];
          const neighborPosY = cellCentersY[neighborIdx];

          const result = computeFlowWeight(
            neighborPosX,
            neighborPosY,
            currentPosX,
            currentPosY,
            sourceDirX,
            sourceDirY,
            propagationConfig,
          );

          if (result.weight > 0) {
            totalWeight += result.weight;
            totalEnergy += energy[neighborIdx] * result.weight;

            const contribution = energy[neighborIdx] * result.weight;
            // Use pre-computed normalized direction from computeFlowWeight
            weightedDirX += result.flowDirX * contribution;
            weightedDirY += result.flowDirY * contribution;
          }
        }

        let newEnergy = 0;
        if (totalWeight > 0) {
          newEnergy = clamp01(totalEnergy / totalWeight);
        }

        nextEnergy[idx] = newEnergy;
        maxChange = Math.max(maxChange, Math.abs(newEnergy - energy[idx]));

        deflectionX[idx] = weightedDirX;
        deflectionY[idx] = weightedDirY;
      }
    }

    energy.set(nextEnergy);
    iterations++;
  }

  // Write final values
  for (let y = 0; y < cellsY; y++) {
    for (let x = 0; x < cellsX; x++) {
      const idx = y * cellsX + x;
      const outIdx = dirOffset + idx * 4;

      if (waterMask[idx] === 0) {
        outWindData[outIdx] = 0;
        outWindData[outIdx + 1] = 0;
        outWindData[outIdx + 2] = 0;
        outWindData[outIdx + 3] = 0;
        continue;
      }

      const speedFactor = energy[idx];

      let directionOffset = 0;
      const dirMag = Math.sqrt(
        deflectionX[idx] * deflectionX[idx] +
          deflectionY[idx] * deflectionY[idx],
      );
      if (dirMag > 0.001) {
        const actualAngle = Math.atan2(
          deflectionY[idx] / dirMag,
          deflectionX[idx] / dirMag,
        );
        directionOffset = actualAngle - sourceAngle;
        while (directionOffset > Math.PI) directionOffset -= Math.PI * 2;
        while (directionOffset < -Math.PI) directionOffset += Math.PI * 2;
      }

      const turbulence = computeTurbulence(
        x,
        y,
        idx,
        energy,
        waterMask,
        cellsX,
        cellsY,
      );

      outWindData[outIdx] = speedFactor;
      outWindData[outIdx + 1] = directionOffset;
      outWindData[outIdx + 2] = turbulence;
      outWindData[outIdx + 3] = 0;
    }
  }

  return {
    converged: maxChange <= propagationConfig.convergenceThreshold,
    iterations,
    maxChange,
  };
}

function computeWindBatch(
  directions: number[],
  sourceAngles: number[],
  waterMask: Uint8Array,
  gridConfig: SerializableGridConfig,
  propagationConfig: SerializablePropagationConfig,
  onDirectionComplete?: (dirIndex: number, batchProgress: number) => void,
): { windData: Float32Array } {
  const { cellsX, cellsY } = gridConfig;
  const cellCount = cellsX * cellsY;
  const totalFloats = directions.length * cellCount * 4;
  const windData = new Float32Array(totalFloats);

  for (let i = 0; i < directions.length; i++) {
    const dirIndex = directions[i];
    const sourceAngle = sourceAngles[i];
    const localDirIndex = i;

    const result = propagateWindForDirection(
      localDirIndex,
      sourceAngle,
      waterMask,
      gridConfig,
      propagationConfig,
      windData,
    );

    if (!result.converged) {
      console.warn(
        `[WindWorker] Direction ${dirIndex} did not converge: ${result.iterations} iterations`,
      );
    }

    onDirectionComplete?.(dirIndex, (i + 1) / directions.length);
  }

  return { windData };
}

// ============================================================================
// Worker Entry Point
// ============================================================================

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent<WindWorkerRequest>) => {
  const message = event.data;

  if (message.type === "compute") {
    try {
      const {
        batchId,
        directions,
        gridConfig,
        propagationConfig,
        waterMask,
        sourceAngles,
      } = message;

      const result = computeWindBatch(
        directions,
        sourceAngles,
        waterMask,
        gridConfig,
        propagationConfig,
        (completedDirection, batchProgress) => {
          const progressMsg: WindWorkerOutgoingMessage = {
            type: "progress",
            batchId,
            completedDirection,
            batchProgress,
          };
          ctx.postMessage(progressMsg);
        },
      );

      const resultMsg: WindWorkerOutgoingMessage = {
        type: "result",
        batchId,
        directions,
        windData: result.windData,
      };

      ctx.postMessage(resultMsg, [result.windData.buffer]);
    } catch (error) {
      const errorMsg: WindWorkerOutgoingMessage = {
        type: "error",
        batchId: message.batchId,
        message: error instanceof Error ? error.message : String(error),
      };
      ctx.postMessage(errorMsg);
    }
  }
};

ctx.postMessage({ type: "ready" });
