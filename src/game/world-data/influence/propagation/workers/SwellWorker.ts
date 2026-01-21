/**
 * Swell Propagation Web Worker
 *
 * Computes how terrain affects wave propagation using an iterative relaxation algorithm.
 * Runs in a separate thread for parallel computation across multiple directions.
 *
 * Message Protocol:
 * - Receives: SwellWorkerRequest with directions, grid config, and water mask
 * - Sends: SwellWorkerProgress after each direction, SwellWorkerResult when complete
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
 * Request from main thread to compute swell propagation.
 */
export interface SwellWorkerRequest {
  type: "compute";
  batchId: number;
  directions: number[];
  gridConfig: SerializableGridConfig;
  propagationConfig: SerializablePropagationConfig;
  waterMask: Uint8Array;
  sourceAngles: number[];
}

/**
 * Request to compute BOTH long swell and short chop.
 */
export interface CombinedSwellWorkerRequest {
  type: "computeCombined";
  batchId: number;
  directions: number[];
  gridConfig: SerializableGridConfig;
  longSwellConfig: SerializablePropagationConfig;
  shortChopConfig: SerializablePropagationConfig;
  waterMask: Uint8Array;
  sourceAngles: number[];
}

/**
 * Progress update from worker to main thread.
 */
export interface SwellWorkerProgress {
  type: "progress";
  batchId: number;
  completedDirection: number;
  batchProgress: number;
}

/**
 * Result from worker to main thread with computed data.
 */
export interface SwellWorkerResult {
  type: "result";
  batchId: number;
  directions: number[];
  energy: Float32Array;
  arrivalDirection: Float32Array;
}

/**
 * Combined result from worker with both wavelength classes.
 * Uses type: "result" for compatibility with generic WorkerPool.
 */
export interface CombinedSwellWorkerResult {
  type: "result";
  batchId: number;
  directions: number[];
  longEnergy: Float32Array;
  longArrivalDirection: Float32Array;
  shortEnergy: Float32Array;
  shortArrivalDirection: Float32Array;
}

/**
 * Error from worker to main thread.
 */
export interface SwellWorkerError {
  type: "error";
  batchId: number;
  message: string;
}

export type SwellWorkerIncomingMessage =
  | SwellWorkerRequest
  | CombinedSwellWorkerRequest;

export type SwellWorkerOutgoingMessage =
  | SwellWorkerProgress
  | SwellWorkerResult
  | SwellWorkerError
  | CombinedSwellWorkerResult;

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

// Reusable result object to avoid allocations in hot loop
const flowResult: FlowResult = { weight: 0, flowDirX: 0, flowDirY: 0 };

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

function propagateSwellForDirection(
  dirIndex: number,
  sourceAngle: number,
  waterMask: Uint8Array,
  gridConfig: SerializableGridConfig,
  propagationConfig: SerializablePropagationConfig,
  outEnergy: Float32Array,
  outArrivalDirection: Float32Array,
): { converged: boolean; iterations: number; maxChange: number } {
  const { cellsX, cellsY, cellSize, originX, originY } = gridConfig;
  const cellCount = cellsX * cellsY;
  const dirOffset = dirIndex * cellCount;

  const sourceDirX = Math.cos(sourceAngle);
  const sourceDirY = Math.sin(sourceAngle);

  const energy = new Float32Array(cellCount);
  const nextEnergy = new Float32Array(cellCount);
  const arrivalDirX = new Float32Array(cellCount);
  const arrivalDirY = new Float32Array(cellCount);

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
        arrivalDirX[idx] = sourceDirX;
        arrivalDirY[idx] = sourceDirY;
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

        arrivalDirX[idx] = weightedDirX;
        arrivalDirY[idx] = weightedDirY;
      }
    }

    energy.set(nextEnergy);
    iterations++;
  }

  // Write final values
  for (let y = 0; y < cellsY; y++) {
    for (let x = 0; x < cellsX; x++) {
      const idx = y * cellsX + x;
      const outIdx = dirOffset + idx;

      if (waterMask[idx] === 0) {
        outEnergy[outIdx] = 0;
        outArrivalDirection[outIdx] = sourceAngle;
        continue;
      }

      outEnergy[outIdx] = energy[idx];

      let arrivalDir = sourceAngle;
      const dirMag = Math.sqrt(
        arrivalDirX[idx] * arrivalDirX[idx] +
          arrivalDirY[idx] * arrivalDirY[idx],
      );
      if (dirMag > 0.001) {
        arrivalDir = Math.atan2(
          arrivalDirY[idx] / dirMag,
          arrivalDirX[idx] / dirMag,
        );
      }

      outArrivalDirection[outIdx] = arrivalDir;
    }
  }

  return {
    converged: maxChange <= propagationConfig.convergenceThreshold,
    iterations,
    maxChange,
  };
}

function computeSwellBatch(
  directions: number[],
  sourceAngles: number[],
  waterMask: Uint8Array,
  gridConfig: SerializableGridConfig,
  propagationConfig: SerializablePropagationConfig,
  onDirectionComplete?: (dirIndex: number, batchProgress: number) => void,
): { energy: Float32Array; arrivalDirection: Float32Array } {
  const { cellsX, cellsY } = gridConfig;
  const cellCount = cellsX * cellsY;
  const totalCells = directions.length * cellCount;
  const energy = new Float32Array(totalCells);
  const arrivalDirection = new Float32Array(totalCells);

  energy.fill(1.0);

  for (let i = 0; i < directions.length; i++) {
    const dirIndex = directions[i];
    const sourceAngle = sourceAngles[i];
    const localDirIndex = i;

    const result = propagateSwellForDirection(
      localDirIndex,
      sourceAngle,
      waterMask,
      gridConfig,
      propagationConfig,
      energy,
      arrivalDirection,
    );

    if (!result.converged) {
      console.warn(
        `[SwellWorker] Direction ${dirIndex} did not converge: ${result.iterations} iterations`,
      );
    }

    onDirectionComplete?.(dirIndex, (i + 1) / directions.length);
  }

  return { energy, arrivalDirection };
}

function computeCombinedSwellBatch(
  directions: number[],
  sourceAngles: number[],
  waterMask: Uint8Array,
  gridConfig: SerializableGridConfig,
  longSwellConfig: SerializablePropagationConfig,
  shortChopConfig: SerializablePropagationConfig,
  onDirectionComplete?: (dirIndex: number, batchProgress: number) => void,
): {
  longEnergy: Float32Array;
  longArrivalDirection: Float32Array;
  shortEnergy: Float32Array;
  shortArrivalDirection: Float32Array;
} {
  const { cellsX, cellsY } = gridConfig;
  const cellCount = cellsX * cellsY;
  const totalCells = directions.length * cellCount;

  const longEnergy = new Float32Array(totalCells);
  const longArrivalDirection = new Float32Array(totalCells);
  const shortEnergy = new Float32Array(totalCells);
  const shortArrivalDirection = new Float32Array(totalCells);

  longEnergy.fill(1.0);
  shortEnergy.fill(1.0);

  for (let i = 0; i < directions.length; i++) {
    const dirIndex = directions[i];
    const sourceAngle = sourceAngles[i];
    const localDirIndex = i;

    // Compute long swell
    const longResult = propagateSwellForDirection(
      localDirIndex,
      sourceAngle,
      waterMask,
      gridConfig,
      longSwellConfig,
      longEnergy,
      longArrivalDirection,
    );

    if (!longResult.converged) {
      console.warn(`[SwellWorker] Long swell dir ${dirIndex} did not converge`);
    }

    // Compute short chop
    const shortResult = propagateSwellForDirection(
      localDirIndex,
      sourceAngle,
      waterMask,
      gridConfig,
      shortChopConfig,
      shortEnergy,
      shortArrivalDirection,
    );

    if (!shortResult.converged) {
      console.warn(`[SwellWorker] Short chop dir ${dirIndex} did not converge`);
    }

    onDirectionComplete?.(dirIndex, (i + 1) / directions.length);
  }

  return {
    longEnergy,
    longArrivalDirection,
    shortEnergy,
    shortArrivalDirection,
  };
}

// ============================================================================
// Worker Entry Point
// ============================================================================

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent<SwellWorkerIncomingMessage>) => {
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

      const result = computeSwellBatch(
        directions,
        sourceAngles,
        waterMask,
        gridConfig,
        propagationConfig,
        (completedDirection, batchProgress) => {
          const progressMsg: SwellWorkerOutgoingMessage = {
            type: "progress",
            batchId,
            completedDirection,
            batchProgress,
          };
          ctx.postMessage(progressMsg);
        },
      );

      const resultMsg: SwellWorkerOutgoingMessage = {
        type: "result",
        batchId,
        directions,
        energy: result.energy,
        arrivalDirection: result.arrivalDirection,
      };

      ctx.postMessage(resultMsg, [
        result.energy.buffer,
        result.arrivalDirection.buffer,
      ]);
    } catch (error) {
      const errorMsg: SwellWorkerOutgoingMessage = {
        type: "error",
        batchId: message.batchId,
        message: error instanceof Error ? error.message : String(error),
      };
      ctx.postMessage(errorMsg);
    }
  } else if (message.type === "computeCombined") {
    try {
      const {
        batchId,
        directions,
        gridConfig,
        longSwellConfig,
        shortChopConfig,
        waterMask,
        sourceAngles,
      } = message;

      const result = computeCombinedSwellBatch(
        directions,
        sourceAngles,
        waterMask,
        gridConfig,
        longSwellConfig,
        shortChopConfig,
        (completedDirection, batchProgress) => {
          const progressMsg: SwellWorkerOutgoingMessage = {
            type: "progress",
            batchId,
            completedDirection,
            batchProgress,
          };
          ctx.postMessage(progressMsg);
        },
      );

      const resultMsg: SwellWorkerOutgoingMessage = {
        type: "result",
        batchId,
        directions,
        longEnergy: result.longEnergy,
        longArrivalDirection: result.longArrivalDirection,
        shortEnergy: result.shortEnergy,
        shortArrivalDirection: result.shortArrivalDirection,
      };

      ctx.postMessage(resultMsg, [
        result.longEnergy.buffer,
        result.longArrivalDirection.buffer,
        result.shortEnergy.buffer,
        result.shortArrivalDirection.buffer,
      ]);
    } catch (error) {
      const errorMsg: SwellWorkerOutgoingMessage = {
        type: "error",
        batchId: message.batchId,
        message: error instanceof Error ? error.message : String(error),
      };
      ctx.postMessage(errorMsg);
    }
  }
};

ctx.postMessage({ type: "ready" });
