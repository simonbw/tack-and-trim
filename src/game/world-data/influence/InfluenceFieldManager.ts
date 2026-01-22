/**
 * Influence Field Manager
 *
 * Runs terrain-based propagation algorithms at game startup and provides
 * a sampling interface for wind/wave systems to query local conditions.
 *
 * Computes three types of influence fields in parallel using Web Workers:
 * - Wind influence: how terrain blocks and deflects wind
 * - Swell influence: how terrain affects wave propagation (diffraction)
 * - Fetch map: how far wind can blow over open water
 *
 * Creates GPU textures from the computed fields for shader sampling.
 */

import { BaseEntity } from "../../../core/entity/BaseEntity";
import { on } from "../../../core/entity/handler";
import { Game } from "../../../core/Game";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import { distributeWork, WorkerPool } from "../../../core/workers";
import { TerrainInfo } from "../terrain/TerrainInfo";
import {
  createGridConfig,
  FLOATS_PER_CELL,
  InfluenceFieldGrid,
} from "./InfluenceFieldGrid";
import {
  DEFAULT_SWELL_INFLUENCE,
  DEFAULT_WIND_INFLUENCE,
  type InfluenceGridConfig,
  type SwellInfluence,
  type WindInfluence,
} from "./InfluenceFieldTypes";
import { SwellPropagationCompute } from "./propagation/gpu/SwellPropagationCompute";
import { precomputeWaterMask } from "./propagation/PropagationCore";
import { TerrainSampler } from "./propagation/TerrainSampler";
import type {
  FetchWorkerResult,
  SerializableGridConfig,
} from "./propagation/workers/FetchWorker";
import type {
  CombinedSwellWorkerResult,
  SerializablePropagationConfig,
} from "./propagation/workers/SwellWorker";
import type { WindWorkerResult } from "./propagation/workers/WindWorker";
import {
  FETCH_FIELD_RESOLUTION,
  LONG_SWELL_PROPAGATION_CONFIG,
  SHORT_CHOP_PROPAGATION_CONFIG,
  SWELL_FIELD_RESOLUTION,
  WIND_FIELD_RESOLUTION,
  WIND_PROPAGATION_CONFIG,
} from "./PropagationConfig";

/**
 * Combined swell influence for both wavelength classes.
 */
export interface SwellInfluenceSample {
  longSwell: SwellInfluence;
  shortChop: SwellInfluence;
}

/** Padding added around terrain bounds for influence field computation */
const BOUNDS_PADDING = 2000;

/**
 * Progress for individual computation tasks.
 */
export interface TaskProgress {
  wind: number;
  swell: number;
  fetch: number;
}

/**
 * Convert a boolean water mask to Uint8Array for worker transfer.
 */
function waterMaskToUint8Array(waterMask: boolean[]): Uint8Array {
  const result = new Uint8Array(waterMask.length);
  for (let i = 0; i < waterMask.length; i++) {
    result[i] = waterMask[i] ? 1 : 0;
  }
  return result;
}

/**
 * Create a serializable grid config from an InfluenceGridConfig.
 */
function toSerializableGridConfig(
  config: InfluenceGridConfig,
): SerializableGridConfig {
  return {
    cellSize: config.cellSize,
    cellsX: config.cellsX,
    cellsY: config.cellsY,
    originX: config.originX,
    originY: config.originY,
    directionCount: config.directionCount,
  };
}

// ============================================================================
// Wind Worker Request Types
// ============================================================================

interface WindWorkerRequest {
  type: "compute";
  batchId: number;
  directions: number[];
  gridConfig: SerializableGridConfig;
  propagationConfig: SerializablePropagationConfig;
  waterMask: Uint8Array;
  sourceAngles: number[];
}

// ============================================================================
// Swell Worker Request Types
// ============================================================================

interface SwellWorkerRequest {
  type: "computeCombined";
  batchId: number;
  directions: number[];
  gridConfig: SerializableGridConfig;
  longSwellConfig: SerializablePropagationConfig;
  shortChopConfig: SerializablePropagationConfig;
  waterMask: Uint8Array;
  sourceAngles: number[];
}

// ============================================================================
// Fetch Worker Request Types
// ============================================================================

interface FetchWorkerRequest {
  type: "compute";
  batchId: number;
  directions: number[];
  gridConfig: SerializableGridConfig;
  waterMask: Uint8Array;
  upwindAngles: number[];
  maxFetch: number;
  stepSize: number;
}

/** Default maximum fetch distance (~15km) */
const DEFAULT_MAX_FETCH = 50000;

/**
 * Manages pre-computed influence fields for terrain effects on wind and waves.
 *
 * Usage:
 * ```typescript
 * const manager = InfluenceFieldManager.fromGame(game);
 * const windInfluence = manager.sampleWindInfluence(x, y, windDirection);
 * const swellInfluence = manager.sampleSwellInfluence(x, y, swellDirection);
 * const fetch = manager.sampleFetch(x, y, windDirection);
 * ```
 */
export class InfluenceFieldManager extends BaseEntity {
  id = "influenceFieldManager";
  tickLayer = "environment" as const;

  // Stored grids (populated during async initialization)
  private windGrid: InfluenceFieldGrid | null = null;
  private swellGrid: InfluenceFieldGrid | null = null;
  private fetchGrid: InfluenceFieldGrid | null = null;
  private propagationTimeMs: number = 0;

  // Per-field timing (time from start to completion for each field)
  private windTimeMs: number = 0;
  private swellTimeMs: number = 0;
  private fetchTimeMs: number = 0;

  // Track if GPU was used for swell computation
  private swellUsedGPU: boolean = false;

  // GPU textures (created after propagation)
  private swellTexture: GPUTexture | null = null;
  private fetchTexture: GPUTexture | null = null;
  private influenceSampler: GPUSampler | null = null;

  // Worker pools
  private windWorkerPool: WorkerPool<
    WindWorkerRequest,
    WindWorkerResult
  > | null = null;
  private swellWorkerPool: WorkerPool<
    SwellWorkerRequest,
    CombinedSwellWorkerResult
  > | null = null;
  private fetchWorkerPool: WorkerPool<
    FetchWorkerRequest,
    FetchWorkerResult
  > | null = null;

  // Progress tracking
  private windProgress = 0;
  private swellProgress = 0;
  private fetchProgress = 0;

  // Async initialization state
  private initialized = false;
  private initializationResolve: (() => void) | null = null;
  private initializationPromise: Promise<void>;

  constructor() {
    super();
    this.initializationPromise = new Promise((resolve) => {
      this.initializationResolve = resolve;
    });
  }

  /**
   * Get the InfluenceFieldManager entity from a game instance.
   * Throws if not found.
   */
  static fromGame(game: Game): InfluenceFieldManager {
    const manager = game.entities.getById("influenceFieldManager");
    if (!(manager instanceof InfluenceFieldManager)) {
      throw new Error("InfluenceFieldManager not found in game");
    }
    return manager;
  }

  /**
   * Get the InfluenceFieldManager entity from a game instance, or undefined if not found.
   */
  static maybeFromGame(game: Game): InfluenceFieldManager | undefined {
    const manager = game.entities.getById("influenceFieldManager");
    return manager instanceof InfluenceFieldManager ? manager : undefined;
  }

  @on("afterAdded")
  onAfterAdded() {
    // Start async initialization (doesn't block the main thread)
    this.computeAsync();
  }

  /**
   * Compute all influence fields in parallel using Web Workers.
   * This keeps the main thread responsive during computation.
   */
  private async computeAsync(): Promise<void> {
    const startTime = performance.now();

    // Get terrain info
    const terrain = TerrainInfo.fromGame(this.game);
    const terrainDef = terrain.getTerrainDefinition();

    // Compute bounds from all control points
    let minX = Infinity,
      maxX = -Infinity;
    let minY = Infinity,
      maxY = -Infinity;

    for (const contour of terrainDef.contours) {
      for (const pt of contour.controlPoints) {
        minX = Math.min(minX, pt.x);
        maxX = Math.max(maxX, pt.x);
        minY = Math.min(minY, pt.y);
        maxY = Math.max(maxY, pt.y);
      }
    }

    // If no contours, use a default area
    if (!Number.isFinite(minX)) {
      minX = -500;
      maxX = 500;
      minY = -500;
      maxY = 500;
    }

    // Add padding for influence to extend beyond terrain
    minX -= BOUNDS_PADDING;
    maxX += BOUNDS_PADDING;
    minY -= BOUNDS_PADDING;
    maxY += BOUNDS_PADDING;

    // Create terrain sampler for propagation algorithms
    const sampler = new TerrainSampler(terrainDef);

    // Create grid configs with appropriate resolutions
    const windGridConfig = createGridConfig(
      minX,
      maxX,
      minY,
      maxY,
      WIND_FIELD_RESOLUTION.cellSize,
      WIND_FIELD_RESOLUTION.directionCount,
    );

    const swellGridConfig = createGridConfig(
      minX,
      maxX,
      minY,
      maxY,
      SWELL_FIELD_RESOLUTION.cellSize,
      SWELL_FIELD_RESOLUTION.directionCount,
    );

    const fetchGridConfig = createGridConfig(
      minX,
      maxX,
      minY,
      maxY,
      FETCH_FIELD_RESOLUTION.cellSize,
      FETCH_FIELD_RESOLUTION.directionCount,
    );

    // Create worker pools
    this.windWorkerPool = new WorkerPool<WindWorkerRequest, WindWorkerResult>({
      workerUrl: new URL(
        "./propagation/workers/WindWorker.ts",
        import.meta.url,
      ),
      label: "WindWorker",
    });

    this.swellWorkerPool = new WorkerPool<
      SwellWorkerRequest,
      CombinedSwellWorkerResult
    >({
      workerUrl: new URL(
        "./propagation/workers/SwellWorker.ts",
        import.meta.url,
      ),
      label: "SwellWorker",
    });

    this.fetchWorkerPool = new WorkerPool<
      FetchWorkerRequest,
      FetchWorkerResult
    >({
      workerUrl: new URL(
        "./propagation/workers/FetchWorker.ts",
        import.meta.url,
      ),
      label: "FetchWorker",
    });

    // Initialize all worker pools in parallel
    await Promise.all([
      this.windWorkerPool.initialize(),
      this.swellWorkerPool.initialize(),
      this.fetchWorkerPool.initialize(),
    ]);

    console.log("[InfluenceFieldManager] Starting parallel computation...");

    // Start all three computations in parallel
    const windPromise = this.computeWindField(
      sampler,
      windGridConfig,
      startTime,
    );
    const swellPromise = this.computeSwellField(
      sampler,
      swellGridConfig,
      startTime,
    );
    const fetchPromise = this.computeFetchField(
      sampler,
      fetchGridConfig,
      startTime,
    );

    // Wait for all to complete
    const [windGrid, swellGrid, fetchGrid] = await Promise.all([
      windPromise,
      swellPromise,
      fetchPromise,
    ]);

    this.windGrid = windGrid;
    this.swellGrid = swellGrid;
    this.fetchGrid = fetchGrid;

    const propagationTime = performance.now() - startTime;
    console.log(
      `[InfluenceFieldManager] All fields computed: ${propagationTime.toFixed(0)}ms`,
    );

    // Create GPU textures
    const textureStart = performance.now();
    if (getWebGPU().isInitialized) {
      this.createGPUTextures(swellGrid, fetchGrid);
      console.log(
        `[InfluenceFieldManager] GPU textures: ${(performance.now() - textureStart).toFixed(0)}ms`,
      );
    } else {
      console.log(
        "[InfluenceFieldManager] WebGPU not available, skipping texture creation",
      );
    }

    // Complete
    this.initialized = true;
    const totalTime = performance.now() - startTime;
    this.propagationTimeMs = totalTime;
    console.log(`[InfluenceFieldManager] Total: ${totalTime.toFixed(0)}ms`);

    // Resolve the initialization promise
    if (this.initializationResolve) {
      this.initializationResolve();
    }

    // Dispatch event for visual entities to be added
    this.game.dispatch("influenceFieldsReady", {});
  }

  /**
   * Compute wind influence field using worker pool.
   */
  private async computeWindField(
    sampler: TerrainSampler,
    gridConfig: InfluenceGridConfig,
    startTime: number,
  ): Promise<InfluenceFieldGrid> {
    const pool = this.windWorkerPool!;
    const { directionCount, cellsX, cellsY } = gridConfig;

    // Create output grid
    const grid = new InfluenceFieldGrid(gridConfig);

    // Pre-compute water mask
    const waterMask = precomputeWaterMask(sampler, gridConfig);
    const waterMaskUint8 = waterMaskToUint8Array(waterMask);

    // Pre-compute source angles
    const sourceAngles: number[] = [];
    for (let dir = 0; dir < directionCount; dir++) {
      sourceAngles.push((dir / directionCount) * Math.PI * 2);
    }

    // Distribute directions among workers
    const directionIndices = Array.from(
      { length: directionCount },
      (_, i) => i,
    );
    const batches = distributeWork(directionIndices, pool.getWorkerCount());

    // Create batch requests
    const serializableConfig = toSerializableGridConfig(gridConfig);
    const propagationConfig: SerializablePropagationConfig = {
      directFlowFactor: WIND_PROPAGATION_CONFIG.directFlowFactor,
      lateralSpreadFactor: WIND_PROPAGATION_CONFIG.lateralSpreadFactor,
      decayFactor: WIND_PROPAGATION_CONFIG.decayFactor,
      maxIterations: WIND_PROPAGATION_CONFIG.maxIterations,
      convergenceThreshold: WIND_PROPAGATION_CONFIG.convergenceThreshold,
    };

    const requests: WindWorkerRequest[] = batches.map((directions) => ({
      type: "compute" as const,
      batchId: 0, // Will be set by WorkerPool
      directions,
      gridConfig: serializableConfig,
      propagationConfig,
      waterMask: waterMaskUint8, // Share reference - workers only read
      sourceAngles: directions.map((dir) => sourceAngles[dir]),
    }));

    // Run computation
    const task = pool.run({
      batches: requests,
      combineResults: (results) => {
        // Merge results into grid
        const cellCount = cellsX * cellsY;
        for (const result of results) {
          for (let i = 0; i < result.directions.length; i++) {
            const dir = result.directions[i];
            const srcOffset = i * cellCount * 4;
            const dstDirOffset = dir * cellsY * cellsX * 4;

            for (let j = 0; j < cellCount; j++) {
              const srcIdx = srcOffset + j * 4;
              const dstIdx = dstDirOffset + j * 4;
              grid.data[dstIdx + 0] = result.windData[srcIdx + 0];
              grid.data[dstIdx + 1] = result.windData[srcIdx + 1];
              grid.data[dstIdx + 2] = result.windData[srcIdx + 2];
              grid.data[dstIdx + 3] = result.windData[srcIdx + 3];
            }
          }
        }
        return results[0]; // Return first result (we've already merged into grid)
      },
      getTransferables: () => [], // waterMask copied via structured clone (read-only)
      onProgress: (p) => {
        this.windProgress = p;
      },
    });

    await task.promise;
    this.windTimeMs = performance.now() - startTime;
    this.windProgress = 1;

    return grid;
  }

  /**
   * Check if CPU swell computation is forced via window flag or static property.
   * Set window.__FORCE_CPU_SWELL = true before page load to force CPU mode.
   */
  private static shouldForceCPUSwell(): boolean {
    return (
      (typeof window !== "undefined" &&
        (window as any).__FORCE_CPU_SWELL === true) ||
      InfluenceFieldManager.FORCE_CPU_SWELL
    );
  }

  /**
   * Set to true to force CPU workers for swell computation even when GPU is available.
   * Useful for benchmarking and debugging.
   */
  static FORCE_CPU_SWELL = false;

  /**
   * Compute swell influence field using GPU if available, otherwise workers.
   */
  private async computeSwellField(
    sampler: TerrainSampler,
    gridConfig: InfluenceGridConfig,
    startTime: number,
  ): Promise<InfluenceFieldGrid> {
    // Try GPU path first if WebGPU is available and not forced to CPU
    if (
      getWebGPU().isInitialized &&
      !InfluenceFieldManager.shouldForceCPUSwell()
    ) {
      try {
        const result = await this.computeSwellFieldGPU(
          sampler,
          gridConfig,
          startTime,
        );
        this.swellUsedGPU = true;
        return result;
      } catch (error) {
        console.warn(
          "[InfluenceFieldManager] GPU swell computation failed, falling back to workers:",
          error,
        );
      }
    }

    // Fall back to worker pool
    this.swellUsedGPU = false;
    return this.computeSwellFieldWorkers(sampler, gridConfig, startTime);
  }

  /**
   * Compute swell influence field using GPU compute shaders.
   *
   * Uses optimized 3D dispatch to process ALL 32 direction/wavelength
   * combinations simultaneously, reducing GPU overhead dramatically.
   */
  private async computeSwellFieldGPU(
    sampler: TerrainSampler,
    gridConfig: InfluenceGridConfig,
    startTime: number,
  ): Promise<InfluenceFieldGrid> {
    const { directionCount, cellsX, cellsY } = gridConfig;

    // Create output grid
    const grid = new InfluenceFieldGrid(gridConfig);

    // Pre-compute water mask
    const waterMask = precomputeWaterMask(sampler, gridConfig);
    const waterMaskUint8 = waterMaskToUint8Array(waterMask);

    // Initialize GPU compute with 3D buffer support
    const compute = new SwellPropagationCompute();
    await compute.init({ cellsX, cellsY, directionCount }, waterMaskUint8);

    console.log(
      `[InfluenceFieldManager] Computing swell field on GPU (${cellsX}x${cellsY}, ${directionCount} directions × 2 wavelengths)`,
    );

    const cellCount = cellsX * cellsY;

    // ONE call computes all 32 direction/wavelength combinations
    // Use fewer iterations than CPU since GPU can't early-terminate.
    // CPU typically converges in 108-165 iterations.
    const gpuIterations = 150;
    await compute.computeAll(
      LONG_SWELL_PROPAGATION_CONFIG,
      SHORT_CHOP_PROPAGATION_CONFIG,
      gpuIterations,
    );

    // ONE readback gets all results
    const { energy, arrivalDirection } = await compute.readback();

    // Copy results to grid
    // GPU buffer layout: [slice][y][x] where slice 0-15 = long, 16-31 = short
    // Grid layout: [dir][y][x][channel] where channel 0-1 = long, 2-3 = short
    for (let dir = 0; dir < directionCount; dir++) {
      const longSliceOffset = dir * cellCount;
      const shortSliceOffset = (dir + directionCount) * cellCount;
      const gridDirOffset = dir * cellsY * cellsX * 4;

      for (let j = 0; j < cellCount; j++) {
        const gridIdx = gridDirOffset + j * 4;
        grid.data[gridIdx + 0] = energy[longSliceOffset + j];
        grid.data[gridIdx + 1] = arrivalDirection[longSliceOffset + j];
        grid.data[gridIdx + 2] = energy[shortSliceOffset + j];
        grid.data[gridIdx + 3] = arrivalDirection[shortSliceOffset + j];
      }
    }

    // Log timing breakdown
    const timing = compute.getTiming();
    if (timing) {
      const lines = [
        `setup: ${timing.setupMs.toFixed(1)}ms`,
        `init pass: ${timing.initPassMs.toFixed(1)}ms`,
        `encode iterations: ${timing.encodeIterationsMs.toFixed(1)}ms`,
        `submit: ${timing.submitMs.toFixed(1)}ms`,
        `gpu wait: ${timing.gpuWaitMs.toFixed(1)}ms`,
        `readback copy: ${timing.readbackCopyMs.toFixed(1)}ms`,
        `readback map: ${timing.readbackMapMs.toFixed(1)}ms`,
        `readback read: ${timing.readbackReadMs.toFixed(1)}ms`,
        `TOTAL compute: ${timing.totalComputeMs.toFixed(1)}ms`,
        `TOTAL readback: ${timing.totalReadbackMs.toFixed(1)}ms`,
      ];
      console.log(
        `[InfluenceFieldManager] GPU swell timing: ${lines.join(" | ")}`,
      );
    }

    compute.destroy();

    this.swellTimeMs = performance.now() - startTime;
    this.swellProgress = 1;

    console.log(
      `[InfluenceFieldManager] GPU swell field complete: ${this.swellTimeMs.toFixed(0)}ms`,
    );

    return grid;
  }

  /**
   * Compute swell influence field using worker pool.
   */
  private async computeSwellFieldWorkers(
    sampler: TerrainSampler,
    gridConfig: InfluenceGridConfig,
    startTime: number,
  ): Promise<InfluenceFieldGrid> {
    const pool = this.swellWorkerPool!;
    const { directionCount, cellsX, cellsY } = gridConfig;

    // Create output grid
    const grid = new InfluenceFieldGrid(gridConfig);

    // Pre-compute water mask
    const waterMask = precomputeWaterMask(sampler, gridConfig);
    const waterMaskUint8 = waterMaskToUint8Array(waterMask);

    // Pre-compute source angles
    const sourceAngles: number[] = [];
    for (let dir = 0; dir < directionCount; dir++) {
      sourceAngles.push((dir / directionCount) * Math.PI * 2);
    }

    // Distribute directions among workers
    const directionIndices = Array.from(
      { length: directionCount },
      (_, i) => i,
    );
    const batches = distributeWork(directionIndices, pool.getWorkerCount());

    // Create batch requests
    const serializableConfig = toSerializableGridConfig(gridConfig);
    const longSwellConfig: SerializablePropagationConfig = {
      directFlowFactor: LONG_SWELL_PROPAGATION_CONFIG.directFlowFactor,
      lateralSpreadFactor: LONG_SWELL_PROPAGATION_CONFIG.lateralSpreadFactor,
      decayFactor: LONG_SWELL_PROPAGATION_CONFIG.decayFactor,
      maxIterations: LONG_SWELL_PROPAGATION_CONFIG.maxIterations,
      convergenceThreshold: LONG_SWELL_PROPAGATION_CONFIG.convergenceThreshold,
    };
    const shortChopConfig: SerializablePropagationConfig = {
      directFlowFactor: SHORT_CHOP_PROPAGATION_CONFIG.directFlowFactor,
      lateralSpreadFactor: SHORT_CHOP_PROPAGATION_CONFIG.lateralSpreadFactor,
      decayFactor: SHORT_CHOP_PROPAGATION_CONFIG.decayFactor,
      maxIterations: SHORT_CHOP_PROPAGATION_CONFIG.maxIterations,
      convergenceThreshold: SHORT_CHOP_PROPAGATION_CONFIG.convergenceThreshold,
    };

    const requests: SwellWorkerRequest[] = batches.map((directions) => ({
      type: "computeCombined" as const,
      batchId: 0,
      directions,
      gridConfig: serializableConfig,
      longSwellConfig,
      shortChopConfig,
      waterMask: waterMaskUint8, // Share reference - workers only read
      sourceAngles: directions.map((dir) => sourceAngles[dir]),
    }));

    // Run computation
    const task = pool.run({
      batches: requests,
      combineResults: (results) => {
        // Merge results into grid (RGBA = longEnergy, longDir, shortEnergy, shortDir)
        const cellCount = cellsX * cellsY;
        for (const result of results) {
          for (let i = 0; i < result.directions.length; i++) {
            const dir = result.directions[i];
            const srcOffset = i * cellCount;
            const dstDirOffset = dir * cellsY * cellsX * 4;

            for (let j = 0; j < cellCount; j++) {
              const srcIdx = srcOffset + j;
              const dstIdx = dstDirOffset + j * 4;
              grid.data[dstIdx + 0] = result.longEnergy[srcIdx];
              grid.data[dstIdx + 1] = result.longArrivalDirection[srcIdx];
              grid.data[dstIdx + 2] = result.shortEnergy[srcIdx];
              grid.data[dstIdx + 3] = result.shortArrivalDirection[srcIdx];
            }
          }
        }
        return results[0];
      },
      getTransferables: () => [], // waterMask copied via structured clone (read-only)
      onProgress: (p) => {
        this.swellProgress = p;
      },
    });

    await task.promise;
    this.swellTimeMs = performance.now() - startTime;
    this.swellProgress = 1;

    return grid;
  }

  /**
   * Compute fetch map using worker pool.
   */
  private async computeFetchField(
    sampler: TerrainSampler,
    gridConfig: InfluenceGridConfig,
    startTime: number,
  ): Promise<InfluenceFieldGrid> {
    const pool = this.fetchWorkerPool!;
    const { directionCount, cellsX, cellsY } = gridConfig;

    // Create output grid
    const grid = new InfluenceFieldGrid(gridConfig);

    // Pre-compute water mask
    const waterMask = precomputeWaterMask(sampler, gridConfig);
    const waterMaskUint8 = waterMaskToUint8Array(waterMask);

    // Pre-compute upwind angles (opposite of source direction)
    const upwindAngles: number[] = [];
    for (let dir = 0; dir < directionCount; dir++) {
      const sourceAngle = (dir / directionCount) * Math.PI * 2;
      upwindAngles.push(sourceAngle + Math.PI);
    }

    // Distribute directions among workers
    const directionIndices = Array.from(
      { length: directionCount },
      (_, i) => i,
    );
    const batches = distributeWork(directionIndices, pool.getWorkerCount());

    // Create batch requests
    const serializableConfig = toSerializableGridConfig(gridConfig);
    const stepSize = gridConfig.cellSize / 2;

    const requests: FetchWorkerRequest[] = batches.map((directions) => ({
      type: "compute" as const,
      batchId: 0,
      directions,
      gridConfig: serializableConfig,
      waterMask: waterMaskUint8, // Share reference - workers only read
      upwindAngles: directions.map((dir) => upwindAngles[dir]),
      maxFetch: DEFAULT_MAX_FETCH,
      stepSize,
    }));

    // Run computation
    const task = pool.run({
      batches: requests,
      combineResults: (results) => {
        // Merge results into grid
        const cellCount = cellsX * cellsY;
        for (const result of results) {
          for (let i = 0; i < result.directions.length; i++) {
            const dir = result.directions[i];
            const srcOffset = i * cellCount * 4;
            const dstDirOffset = dir * cellsY * cellsX * 4;

            for (let j = 0; j < cellCount; j++) {
              const srcIdx = srcOffset + j * 4;
              const dstIdx = dstDirOffset + j * 4;
              grid.data[dstIdx + 0] = result.fetchData[srcIdx + 0];
              grid.data[dstIdx + 1] = result.fetchData[srcIdx + 1];
              grid.data[dstIdx + 2] = result.fetchData[srcIdx + 2];
              grid.data[dstIdx + 3] = result.fetchData[srcIdx + 3];
            }
          }
        }
        return results[0];
      },
      getTransferables: () => [], // waterMask copied via structured clone (read-only)
      onProgress: (p) => {
        this.fetchProgress = p;
      },
    });

    await task.promise;
    this.fetchTimeMs = performance.now() - startTime;
    this.fetchProgress = 1;

    return grid;
  }

  /**
   * Create GPU 3D textures from influence field grids.
   */
  private createGPUTextures(
    swellGrid: InfluenceFieldGrid,
    fetchGrid: InfluenceFieldGrid,
  ): void {
    const device = getWebGPU().device;

    // Create swell influence texture (3D: x, y, direction)
    const swellConfig = swellGrid.config;
    this.swellTexture = device.createTexture({
      size: {
        width: swellConfig.cellsX,
        height: swellConfig.cellsY,
        depthOrArrayLayers: swellConfig.directionCount,
      },
      format: "rgba32float",
      dimension: "3d",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      label: "Swell Influence Texture",
    });

    // Upload swell data
    device.queue.writeTexture(
      { texture: this.swellTexture },
      swellGrid.data.buffer,
      {
        bytesPerRow: swellConfig.cellsX * FLOATS_PER_CELL * 4,
        rowsPerImage: swellConfig.cellsY,
      },
      {
        width: swellConfig.cellsX,
        height: swellConfig.cellsY,
        depthOrArrayLayers: swellConfig.directionCount,
      },
    );

    // Create fetch texture (3D: x, y, direction)
    const fetchConfig = fetchGrid.config;
    this.fetchTexture = device.createTexture({
      size: {
        width: fetchConfig.cellsX,
        height: fetchConfig.cellsY,
        depthOrArrayLayers: fetchConfig.directionCount,
      },
      format: "rgba32float",
      dimension: "3d",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      label: "Fetch Influence Texture",
    });

    // Upload fetch data
    device.queue.writeTexture(
      { texture: this.fetchTexture },
      fetchGrid.data.buffer,
      {
        bytesPerRow: fetchConfig.cellsX * FLOATS_PER_CELL * 4,
        rowsPerImage: fetchConfig.cellsY,
      },
      {
        width: fetchConfig.cellsX,
        height: fetchConfig.cellsY,
        depthOrArrayLayers: fetchConfig.directionCount,
      },
    );

    // Create sampler with linear filtering for hardware interpolation
    this.influenceSampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
      addressModeW: "repeat", // Direction wraps around
      label: "Influence Field Sampler",
    });

    console.log(
      `[InfluenceFieldManager] Created swell texture: ${swellConfig.cellsX}x${swellConfig.cellsY}x${swellConfig.directionCount}`,
    );
    console.log(
      `[InfluenceFieldManager] Created fetch texture: ${fetchConfig.cellsX}x${fetchConfig.cellsY}x${fetchConfig.directionCount}`,
    );
  }

  /**
   * Get the current progress of each computation task.
   * Called by UI to update progress bars.
   */
  getProgress(): TaskProgress {
    return {
      wind: this.windProgress,
      swell: this.swellProgress,
      fetch: this.fetchProgress,
    };
  }

  /**
   * Wait for the influence fields to finish computing.
   * Returns immediately if already initialized.
   */
  waitForInitialization(): Promise<void> {
    return this.initializationPromise;
  }

  /**
   * Sample wind influence at a world position for a given wind direction.
   *
   * @param worldX - World X coordinate in ft
   * @param worldY - World Y coordinate in ft
   * @param windDirection - Wind source direction in radians
   * @returns Wind influence at this position (speedFactor, directionOffset, turbulence)
   */
  sampleWindInfluence(
    worldX: number,
    worldY: number,
    windDirection: number,
  ): WindInfluence {
    if (!this.windGrid) return DEFAULT_WIND_INFLUENCE;
    const values = this.windGrid.sample(worldX, worldY, windDirection);
    return {
      speedFactor: values[0], // R channel
      directionOffset: values[1], // G channel
      turbulence: values[2], // B channel
    };
  }

  /**
   * Sample swell influence at a world position for a given swell direction.
   *
   * @param worldX - World X coordinate in ft
   * @param worldY - World Y coordinate in ft
   * @param swellDirection - Swell source direction in radians
   * @returns Swell influence for both wavelength classes
   */
  sampleSwellInfluence(
    worldX: number,
    worldY: number,
    swellDirection: number,
  ): SwellInfluenceSample {
    if (!this.swellGrid) {
      return {
        longSwell: DEFAULT_SWELL_INFLUENCE,
        shortChop: DEFAULT_SWELL_INFLUENCE,
      };
    }
    const values = this.swellGrid.sample(worldX, worldY, swellDirection);
    return {
      longSwell: {
        energyFactor: values[0], // R channel
        arrivalDirection: values[1], // G channel
      },
      shortChop: {
        energyFactor: values[2], // B channel
        arrivalDirection: values[3], // A channel
      },
    };
  }

  /**
   * Sample fetch distance at a world position for a given wind direction.
   *
   * Fetch is the distance wind has traveled over open water, which affects
   * wave development - longer fetch produces larger waves.
   *
   * @param worldX - World X coordinate in ft
   * @param worldY - World Y coordinate in ft
   * @param windDirection - Wind source direction in radians
   * @returns Fetch distance in ft
   */
  sampleFetch(worldX: number, worldY: number, windDirection: number): number {
    if (!this.fetchGrid) return 0;
    const values = this.fetchGrid.sample(worldX, worldY, windDirection);
    return values[0]; // Fetch is in R channel
  }

  /**
   * Check if the influence fields have been computed.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get the wind influence grid for direct access (e.g., visualization).
   */
  getWindGrid(): InfluenceFieldGrid | null {
    return this.windGrid;
  }

  /**
   * Get the swell influence grid for direct access (e.g., visualization).
   */
  getSwellGrid(): InfluenceFieldGrid | null {
    return this.swellGrid;
  }

  /**
   * Get the fetch grid for direct access (e.g., visualization).
   */
  getFetchGrid(): InfluenceFieldGrid | null {
    return this.fetchGrid;
  }

  /**
   * Get the swell influence GPU texture.
   * Returns null if not yet initialized or WebGPU not available.
   */
  getSwellTexture(): GPUTexture | null {
    return this.swellTexture;
  }

  /**
   * Get the fetch influence GPU texture.
   * Returns null if not yet initialized or WebGPU not available.
   */
  getFetchTexture(): GPUTexture | null {
    return this.fetchTexture;
  }

  /**
   * Get the influence field sampler for GPU usage.
   * Returns null if not yet initialized or WebGPU not available.
   */
  getInfluenceSampler(): GPUSampler | null {
    return this.influenceSampler;
  }

  /**
   * Get the swell field grid configuration (for UV calculations).
   */
  getSwellGridConfig() {
    return this.swellGrid?.config ?? null;
  }

  /**
   * Get the fetch field grid configuration (for UV calculations).
   */
  getFetchGridConfig() {
    return this.fetchGrid?.config ?? null;
  }

  /**
   * Get the time taken to compute all propagation fields in milliseconds.
   * Useful for performance monitoring and testing.
   */
  getPropagationTimeMs(): number {
    return this.propagationTimeMs;
  }

  /**
   * Get the time taken to compute wind influence field in milliseconds.
   * Time is measured from start of all computations to wind completion.
   */
  getWindTimeMs(): number {
    return this.windTimeMs;
  }

  /**
   * Get the time taken to compute swell influence field in milliseconds.
   * Time is measured from start of all computations to swell completion.
   */
  getSwellTimeMs(): number {
    return this.swellTimeMs;
  }

  /**
   * Get the time taken to compute fetch map in milliseconds.
   * Time is measured from start of all computations to fetch completion.
   */
  getFetchTimeMs(): number {
    return this.fetchTimeMs;
  }

  /**
   * Check if GPU was used for swell computation.
   * Returns true if GPU path was taken, false if workers were used.
   */
  didSwellUseGPU(): boolean {
    return this.swellUsedGPU;
  }

  @on("destroy")
  onDestroy() {
    // Clean up GPU resources
    this.swellTexture?.destroy();
    this.fetchTexture?.destroy();
    this.swellTexture = null;
    this.fetchTexture = null;
    this.influenceSampler = null;

    // Clean up worker pools
    this.windWorkerPool?.terminate();
    this.swellWorkerPool?.terminate();
    this.fetchWorkerPool?.terminate();
    this.windWorkerPool = null;
    this.swellWorkerPool = null;
    this.fetchWorkerPool = null;
  }
}
