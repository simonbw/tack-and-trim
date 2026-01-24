/**
 * Fetch Computation Web Worker
 *
 * Computes fetch distance (distance wind can blow over open water) using ray-marching.
 * Runs in a separate thread for parallel computation across multiple directions.
 *
 * Message Protocol:
 * - Receives: FetchWorkerRequest with directions, grid config, and water mask
 * - Sends: FetchWorkerProgress after each direction, FetchWorkerResult when complete
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
 * Serializable depth grid configuration.
 */
export interface SerializableDepthGridConfig {
  originX: number;
  originY: number;
  cellSize: number;
  cellsX: number;
  cellsY: number;
}

/**
 * Request from main thread to compute fetch map.
 */
export interface FetchWorkerRequest {
  type: "compute";
  batchId: number;
  directions: number[];
  gridConfig: SerializableGridConfig;
  depthGrid: Float32Array;
  depthGridConfig: SerializableDepthGridConfig;
  upwindAngles: number[];
  maxFetch: number;
  stepSize: number;
}

/**
 * Progress update from worker to main thread.
 */
export interface FetchWorkerProgress {
  type: "progress";
  batchId: number;
  completedDirection: number;
  batchProgress: number;
}

/**
 * Result from worker to main thread with computed data.
 */
export interface FetchWorkerResult {
  type: "result";
  batchId: number;
  directions: number[];
  fetchData: Float32Array;
}

/**
 * Error from worker to main thread.
 */
export interface FetchWorkerError {
  type: "error";
  batchId: number;
  message: string;
}

export type FetchWorkerOutgoingMessage =
  | FetchWorkerProgress
  | FetchWorkerResult
  | FetchWorkerError;

// ============================================================================
// Core Algorithm
// ============================================================================

/**
 * Check if a grid cell is land (terrain height >= 0).
 */
function isLandCell(depthGrid: Float32Array, idx: number): boolean {
  return depthGrid[idx] >= 0;
}

function isLandAt(
  px: number,
  py: number,
  depthGrid: Float32Array,
  gridConfig: SerializableGridConfig,
): boolean {
  const gridX = Math.floor((px - gridConfig.originX) / gridConfig.cellSize);
  const gridY = Math.floor((py - gridConfig.originY) / gridConfig.cellSize);

  if (
    gridX < 0 ||
    gridX >= gridConfig.cellsX ||
    gridY < 0 ||
    gridY >= gridConfig.cellsY
  ) {
    return false;
  }

  return isLandCell(depthGrid, gridY * gridConfig.cellsX + gridX);
}

function computeFetchRayMarch(
  startX: number,
  startY: number,
  upwindDirX: number,
  upwindDirY: number,
  depthGrid: Float32Array,
  gridConfig: SerializableGridConfig,
  maxFetch: number,
  stepSize: number,
): number {
  let distance = 0;
  let px = startX;
  let py = startY;

  const stepX = upwindDirX * stepSize;
  const stepY = upwindDirY * stepSize;

  while (distance < maxFetch) {
    px += stepX;
    py += stepY;
    distance += stepSize;

    if (isLandAt(px, py, depthGrid, gridConfig)) {
      return Math.max(0, distance - stepSize);
    }
  }

  return maxFetch;
}

function computeFetchForDirection(
  dirIndex: number,
  upwindAngle: number,
  depthGrid: Float32Array,
  gridConfig: SerializableGridConfig,
  maxFetch: number,
  stepSize: number,
  outFetchData: Float32Array,
): void {
  const { cellsX, cellsY, cellSize, originX, originY } = gridConfig;
  const cellCount = cellsX * cellsY;
  const dirOffset = dirIndex * cellCount * 4;

  const upwindDirX = Math.cos(upwindAngle);
  const upwindDirY = Math.sin(upwindAngle);

  for (let y = 0; y < cellsY; y++) {
    for (let x = 0; x < cellsX; x++) {
      const idx = y * cellsX + x;
      const outIdx = dirOffset + idx * 4;

      if (isLandCell(depthGrid, idx)) {
        outFetchData[outIdx] = 0;
        outFetchData[outIdx + 1] = 0;
        outFetchData[outIdx + 2] = 0;
        outFetchData[outIdx + 3] = 0;
        continue;
      }

      const startX = originX + (x + 0.5) * cellSize;
      const startY = originY + (y + 0.5) * cellSize;

      const fetch = computeFetchRayMarch(
        startX,
        startY,
        upwindDirX,
        upwindDirY,
        depthGrid,
        gridConfig,
        maxFetch,
        stepSize,
      );

      outFetchData[outIdx] = fetch;
      outFetchData[outIdx + 1] = 0;
      outFetchData[outIdx + 2] = 0;
      outFetchData[outIdx + 3] = 0;
    }
  }
}

function computeFetchBatch(
  directions: number[],
  upwindAngles: number[],
  depthGrid: Float32Array,
  gridConfig: SerializableGridConfig,
  maxFetch: number,
  stepSize: number,
  onDirectionComplete?: (dirIndex: number, batchProgress: number) => void,
): { fetchData: Float32Array } {
  const { cellsX, cellsY } = gridConfig;
  const cellCount = cellsX * cellsY;
  const totalFloats = directions.length * cellCount * 4;
  const fetchData = new Float32Array(totalFloats);

  for (let i = 0; i < directions.length; i++) {
    const dirIndex = directions[i];
    const upwindAngle = upwindAngles[i];
    const localDirIndex = i;

    computeFetchForDirection(
      localDirIndex,
      upwindAngle,
      depthGrid,
      gridConfig,
      maxFetch,
      stepSize,
      fetchData,
    );

    onDirectionComplete?.(dirIndex, (i + 1) / directions.length);
  }

  return { fetchData };
}

// ============================================================================
// Worker Entry Point
// ============================================================================

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent<FetchWorkerRequest>) => {
  const message = event.data;

  if (message.type === "compute") {
    try {
      const {
        batchId,
        directions,
        gridConfig,
        depthGrid,
        upwindAngles,
        maxFetch,
        stepSize,
      } = message;

      const result = computeFetchBatch(
        directions,
        upwindAngles,
        depthGrid,
        gridConfig,
        maxFetch,
        stepSize,
        (completedDirection, batchProgress) => {
          const progressMsg: FetchWorkerOutgoingMessage = {
            type: "progress",
            batchId,
            completedDirection,
            batchProgress,
          };
          ctx.postMessage(progressMsg);
        },
      );

      const resultMsg: FetchWorkerOutgoingMessage = {
        type: "result",
        batchId,
        directions,
        fetchData: result.fetchData,
      };

      ctx.postMessage(resultMsg, [result.fetchData.buffer]);
    } catch (error) {
      const errorMsg: FetchWorkerOutgoingMessage = {
        type: "error",
        batchId: message.batchId,
        message: error instanceof Error ? error.message : String(error),
      };
      ctx.postMessage(errorMsg);
    }
  }
};

ctx.postMessage({ type: "ready" });
