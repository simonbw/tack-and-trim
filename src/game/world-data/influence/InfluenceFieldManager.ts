/**
 * Influence Field Manager
 *
 * Runs terrain-based propagation algorithms at game startup and provides
 * a sampling interface for wind systems to query local conditions.
 *
 * Computes:
 * - Wind influence: how terrain blocks and deflects wind
 * - Depth grid: terrain height for GPU sampling
 *
 * Note: Wave physics uses the analytical shadow-based system (WavePhysicsManager),
 * not this grid-based propagation.
 */

import { BaseEntity } from "../../../core/entity/BaseEntity";
import { on } from "../../../core/entity/handler";
import { Game } from "../../../core/Game";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import { distributeWork, WorkerPool } from "../../../core/workers";
import {
  TerrainRenderPipeline,
  TerrainViewport,
} from "../../surface-rendering/TerrainRenderPipeline";
import type { TerrainDefinition } from "../terrain/LandMass";
import { TerrainInfo } from "../terrain/TerrainInfo";
import {
  DEFAULT_WIND_INFLUENCE,
  type DepthGridConfig,
  type InfluenceGridConfig,
  type WindInfluence,
} from "./InfluenceFieldTypes";
import type { WindWorkerResult } from "./propagation/workers/WindWorker";
import {
  DEPTH_FIELD_CELL_SIZE,
  scaleDecayForCellSize,
  WIND_FIELD_RESOLUTION,
  WIND_PROPAGATION_CONFIG,
} from "./PropagationConfig";

/** Padding added around terrain bounds for influence field computation */
const BOUNDS_PADDING = 2000;

/** Floats per cell in wind grid (speedFactor, directionOffset, turbulence, unused) */
const FLOATS_PER_CELL = 4;

/**
 * Progress for computation tasks.
 */
export interface TaskProgress {
  wind: number;
}

/**
 * Serializable depth grid configuration (for workers).
 */
export interface SerializableDepthGridConfig {
  originX: number;
  originY: number;
  cellSize: number;
  cellsX: number;
  cellsY: number;
}

/**
 * Serializable grid config for workers.
 */
interface SerializableGridConfig {
  cellSize: number;
  cellsX: number;
  cellsY: number;
  originX: number;
  originY: number;
  directionCount: number;
}

/**
 * Serializable propagation config for workers.
 */
interface SerializablePropagationConfig {
  directFlowFactor: number;
  lateralSpreadFactor: number;
  decayFactor: number;
  maxIterations: number;
  convergenceThreshold: number;
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

/**
 * Create an InfluenceGridConfig for the given bounds.
 */
function createGridConfig(
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  cellSize: number,
  directionCount: number,
): InfluenceGridConfig {
  const cellsX = Math.ceil((maxX - minX) / cellSize);
  const cellsY = Math.ceil((maxY - minY) / cellSize);
  return {
    cellSize,
    cellsX,
    cellsY,
    originX: minX,
    originY: minY,
    directionCount,
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
  depthGrid: Float32Array;
  depthGridConfig: SerializableDepthGridConfig;
  sourceAngles: number[];
}

/**
 * Internal grid storage for wind influence.
 * Layout: [direction][y][x][channel] where channel is RGBA (4 floats).
 */
class WindInfluenceGrid {
  readonly data: Float32Array;
  readonly config: InfluenceGridConfig;

  constructor(config: InfluenceGridConfig) {
    this.config = config;
    const cellCount =
      config.cellsX * config.cellsY * config.directionCount * FLOATS_PER_CELL;
    this.data = new Float32Array(cellCount);
  }

  /**
   * Sample wind influence at a world position for a given direction.
   * Uses trilinear interpolation (x, y, direction).
   */
  sample(worldX: number, worldY: number, direction: number): Float32Array {
    const { originX, originY, cellSize, cellsX, cellsY, directionCount } =
      this.config;

    // Normalize direction to [0, 2π)
    let normalizedDir = direction % (Math.PI * 2);
    if (normalizedDir < 0) normalizedDir += Math.PI * 2;

    // Convert to grid coordinates
    const gx = (worldX - originX) / cellSize - 0.5;
    const gy = (worldY - originY) / cellSize - 0.5;
    const gz = (normalizedDir / (Math.PI * 2)) * directionCount;

    // Get integer and fractional parts
    const x0 = Math.max(0, Math.min(cellsX - 2, Math.floor(gx)));
    const y0 = Math.max(0, Math.min(cellsY - 2, Math.floor(gy)));
    const z0 = Math.floor(gz);

    const fx = Math.max(0, Math.min(1, gx - x0));
    const fy = Math.max(0, Math.min(1, gy - y0));
    const fz = gz - z0;

    // Direction wraps around
    const z1 = (z0 + 1) % directionCount;
    const z0Wrapped = ((z0 % directionCount) + directionCount) % directionCount;

    // Helper to get cell value
    const getCellValue = (x: number, y: number, z: number, c: number) => {
      const idx = (z * cellsY * cellsX + y * cellsX + x) * FLOATS_PER_CELL + c;
      return this.data[idx];
    };

    // Trilinear interpolation for each channel
    const result = new Float32Array(4);
    for (let c = 0; c < 4; c++) {
      // 8 corners
      const v000 = getCellValue(x0, y0, z0Wrapped, c);
      const v100 = getCellValue(x0 + 1, y0, z0Wrapped, c);
      const v010 = getCellValue(x0, y0 + 1, z0Wrapped, c);
      const v110 = getCellValue(x0 + 1, y0 + 1, z0Wrapped, c);
      const v001 = getCellValue(x0, y0, z1, c);
      const v101 = getCellValue(x0 + 1, y0, z1, c);
      const v011 = getCellValue(x0, y0 + 1, z1, c);
      const v111 = getCellValue(x0 + 1, y0 + 1, z1, c);

      // Interpolate
      const v00 = v000 * (1 - fx) + v100 * fx;
      const v10 = v010 * (1 - fx) + v110 * fx;
      const v01 = v001 * (1 - fx) + v101 * fx;
      const v11 = v011 * (1 - fx) + v111 * fx;

      const v0 = v00 * (1 - fy) + v10 * fy;
      const v1 = v01 * (1 - fy) + v11 * fy;

      result[c] = v0 * (1 - fz) + v1 * fz;
    }

    return result;
  }
}

/**
 * Manages pre-computed influence fields for terrain effects on wind.
 *
 * Usage:
 * ```typescript
 * const manager = InfluenceFieldManager.fromGame(game);
 * const windInfluence = manager.sampleWindInfluence(x, y, windDirection);
 * ```
 */
export class InfluenceFieldManager extends BaseEntity {
  id = "influenceFieldManager";
  tickLayer = "environment" as const;

  // Wind influence grid (populated during async initialization)
  private windGrid: WindInfluenceGrid | null = null;

  // GPU textures
  private depthTexture: GPUTexture | null = null;

  // Worker pool for wind computation
  private windWorkerPool: WorkerPool<
    WindWorkerRequest,
    WindWorkerResult
  > | null = null;

  // Progress tracking
  private windProgress = 0;

  // Async initialization state
  private initialized = false;
  private initializationResolve: (() => void) | null = null;
  private initializationPromise: Promise<void>;

  // Depth grid data (for land/water detection in workers)
  private depthGrid: Float32Array | null = null;
  private depthGridConfig: DepthGridConfig | null = null;

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
   * Compute influence fields using Web Workers.
   * This keeps the main thread responsive during computation.
   */
  private async computeAsync(): Promise<void> {
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

    // Generate depth grid using TerrainRenderPipeline (GPU-based)
    const { depthGrid, depthGridConfig } = await this.computeDepthGrid(
      terrainDef,
      minX,
      minY,
      maxX - minX,
      maxY - minY,
    );
    this.depthGrid = depthGrid;
    this.depthGridConfig = depthGridConfig;

    // Create wind grid config
    const windGridConfig = createGridConfig(
      minX,
      maxX,
      minY,
      maxY,
      WIND_FIELD_RESOLUTION.cellSize,
      WIND_FIELD_RESOLUTION.directionCount,
    );

    // Create wind worker pool
    this.windWorkerPool = new WorkerPool<WindWorkerRequest, WindWorkerResult>({
      workerUrl: new URL(
        "./propagation/workers/WindWorker.ts",
        import.meta.url,
      ),
      label: "WindWorker",
    });

    await this.windWorkerPool.initialize();

    // Compute wind field
    this.windGrid = await this.computeWindField(
      depthGrid,
      depthGridConfig,
      windGridConfig,
    );

    // Complete
    this.initialized = true;

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
    depthGrid: Float32Array,
    depthGridConfig: DepthGridConfig,
    gridConfig: InfluenceGridConfig,
  ): Promise<WindInfluenceGrid> {
    return this.computeWindFieldWithPool(
      this.windWorkerPool!,
      depthGrid,
      depthGridConfig,
      gridConfig,
    );
  }

  /**
   * Compute depth grid using TerrainRenderPipeline.
   * Returns terrain height as Float32Array (positive = land, negative = water).
   */
  private async computeDepthGrid(
    terrainDef: TerrainDefinition,
    originX: number,
    originY: number,
    width: number,
    height: number,
  ): Promise<{ depthGrid: Float32Array; depthGridConfig: DepthGridConfig }> {
    // Compute texture dimensions from cell size and world bounds
    const cellSize = DEPTH_FIELD_CELL_SIZE;
    const textureSizeX = Math.ceil(width / cellSize);
    const textureSizeY = Math.ceil(height / cellSize);

    const device = getWebGPU().device;

    // Create a dedicated pipeline for depth readback
    const depthPipeline = new TerrainRenderPipeline(textureSizeX, textureSizeY);
    await depthPipeline.init();
    depthPipeline.setTerrainDefinition(terrainDef);

    // Render terrain to texture
    const viewport: TerrainViewport = {
      left: originX,
      top: originY,
      width,
      height,
    };
    depthPipeline.update(viewport, 0);

    // Get the output texture
    const outputTexture = depthPipeline.getOutputTexture();
    if (!outputTexture) {
      depthPipeline.destroy();
      throw new Error("Failed to get depth texture from TerrainRenderPipeline");
    }

    // Create staging buffer for readback
    // WebGPU requires bytesPerRow to be a multiple of 256
    const unalignedBytesPerRow = textureSizeX * 16; // rgba32float = 16 bytes per pixel
    const bytesPerRow = Math.ceil(unalignedBytesPerRow / 256) * 256;
    const stagingBuffer = device.createBuffer({
      size: bytesPerRow * textureSizeY,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      label: "Depth Grid Staging Buffer",
    });

    // Copy texture to staging buffer
    const commandEncoder = device.createCommandEncoder({
      label: "Depth Grid Copy Encoder",
    });
    commandEncoder.copyTextureToBuffer(
      { texture: outputTexture },
      { buffer: stagingBuffer, bytesPerRow },
      { width: textureSizeX, height: textureSizeY },
    );
    device.queue.submit([commandEncoder.finish()]);

    // Read back data
    await stagingBuffer.mapAsync(GPUMapMode.READ);
    const mappedData = new Float32Array(
      stagingBuffer.getMappedRange().slice(0),
    );
    stagingBuffer.unmap();
    stagingBuffer.destroy();

    // Extract R channel (height) from rgba32float data
    const depthGridData = new Float32Array(textureSizeX * textureSizeY);
    const floatsPerRow = bytesPerRow / 4;
    for (let y = 0; y < textureSizeY; y++) {
      for (let x = 0; x < textureSizeX; x++) {
        const srcIdx = y * floatsPerRow + x * 4;
        const dstIdx = y * textureSizeX + x;
        depthGridData[dstIdx] = mappedData[srcIdx];
      }
    }

    // Cleanup the render pipeline
    depthPipeline.destroy();

    // Create a persistent depth texture for the water shader (r32float)
    this.depthTexture = device.createTexture({
      size: { width: textureSizeX, height: textureSizeY },
      format: "r32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      label: "Depth Grid Texture",
    });

    // Upload depth data to texture
    device.queue.writeTexture(
      { texture: this.depthTexture },
      depthGridData,
      { bytesPerRow: textureSizeX * 4 },
      { width: textureSizeX, height: textureSizeY },
    );

    const depthGridConfigResult: DepthGridConfig = {
      originX,
      originY,
      cellSize,
      cellsX: textureSizeX,
      cellsY: textureSizeY,
    };

    return { depthGrid: depthGridData, depthGridConfig: depthGridConfigResult };
  }

  /**
   * Resample depth grid to match influence grid resolution.
   */
  private resampleDepthGrid(
    depthGrid: Float32Array,
    depthGridConfig: DepthGridConfig,
    influenceGridConfig: InfluenceGridConfig,
  ): Float32Array {
    const { cellsX, cellsY, cellSize, originX, originY } = influenceGridConfig;
    const result = new Float32Array(cellsX * cellsY);

    for (let y = 0; y < cellsY; y++) {
      for (let x = 0; x < cellsX; x++) {
        const worldX = originX + (x + 0.5) * cellSize;
        const worldY = originY + (y + 0.5) * cellSize;
        const depth = this.sampleDepthGridBilinear(
          depthGrid,
          depthGridConfig,
          worldX,
          worldY,
        );
        result[y * cellsX + x] = depth;
      }
    }

    return result;
  }

  /**
   * Sample depth grid with bilinear interpolation.
   */
  private sampleDepthGridBilinear(
    depthGrid: Float32Array,
    config: DepthGridConfig,
    worldX: number,
    worldY: number,
  ): number {
    const { originX, originY, cellSize, cellsX, cellsY } = config;

    const gx = (worldX - originX) / cellSize - 0.5;
    const gy = (worldY - originY) / cellSize - 0.5;

    const x0 = Math.max(0, Math.min(cellsX - 2, Math.floor(gx)));
    const y0 = Math.max(0, Math.min(cellsY - 2, Math.floor(gy)));
    const x1 = x0 + 1;
    const y1 = y0 + 1;

    const fx = Math.max(0, Math.min(1, gx - x0));
    const fy = Math.max(0, Math.min(1, gy - y0));

    const v00 = depthGrid[y0 * cellsX + x0];
    const v10 = depthGrid[y0 * cellsX + x1];
    const v01 = depthGrid[y1 * cellsX + x0];
    const v11 = depthGrid[y1 * cellsX + x1];

    const v0 = v00 * (1 - fx) + v10 * fx;
    const v1 = v01 * (1 - fx) + v11 * fx;
    return v0 * (1 - fy) + v1 * fy;
  }

  /**
   * Get the current progress of computation.
   */
  getProgress(): TaskProgress {
    return {
      wind: this.windProgress,
    };
  }

  /**
   * Wait for the influence fields to finish computing.
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
      speedFactor: values[0],
      directionOffset: values[1],
      turbulence: values[2],
    };
  }

  /**
   * Check if the influence fields have been computed.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get the depth GPU texture for shoaling/damping calculations.
   */
  getDepthTexture(): GPUTexture | null {
    return this.depthTexture;
  }

  /**
   * Get the depth grid configuration (for UV calculations).
   */
  getDepthGridConfig(): DepthGridConfig | null {
    return this.depthGridConfig;
  }

  /**
   * Get the depth grid for direct access (e.g., visualization).
   */
  getDepthGrid(): Float32Array | null {
    return this.depthGrid;
  }

  /**
   * Recompute influence fields for updated terrain.
   */
  async recompute(): Promise<void> {
    this.windProgress = 0;

    const terrain = TerrainInfo.fromGame(this.game);
    const terrainDef = terrain.getTerrainDefinition();

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

    if (!Number.isFinite(minX)) {
      minX = -500;
      maxX = 500;
      minY = -500;
      maxY = 500;
    }

    minX -= BOUNDS_PADDING;
    maxX += BOUNDS_PADDING;
    minY -= BOUNDS_PADDING;
    maxY += BOUNDS_PADDING;

    const { depthGrid, depthGridConfig } = await this.computeDepthGrid(
      terrainDef,
      minX,
      minY,
      maxX - minX,
      maxY - minY,
    );
    this.depthGrid = depthGrid;
    this.depthGridConfig = depthGridConfig;

    const windGridConfig = createGridConfig(
      minX,
      maxX,
      minY,
      maxY,
      WIND_FIELD_RESOLUTION.cellSize,
      WIND_FIELD_RESOLUTION.directionCount,
    );

    const newWindPool = new WorkerPool<WindWorkerRequest, WindWorkerResult>({
      workerUrl: new URL(
        "./propagation/workers/WindWorker.ts",
        import.meta.url,
      ),
      label: "WindWorker-recompute",
    });

    await newWindPool.initialize();

    this.windGrid = await this.computeWindFieldWithPool(
      newWindPool,
      depthGrid,
      depthGridConfig,
      windGridConfig,
    );

    newWindPool.terminate();

    if (!this.initialized) {
      this.initialized = true;
      if (this.initializationResolve) {
        this.initializationResolve();
      }
    }

    this.game.dispatch("influenceFieldsReady", {});
  }

  /**
   * Compute wind influence field using a specific worker pool.
   */
  private async computeWindFieldWithPool(
    pool: WorkerPool<WindWorkerRequest, WindWorkerResult>,
    depthGrid: Float32Array,
    depthGridConfig: DepthGridConfig,
    gridConfig: InfluenceGridConfig,
  ): Promise<WindInfluenceGrid> {
    const { directionCount, cellsX, cellsY } = gridConfig;

    const grid = new WindInfluenceGrid(gridConfig);

    const resampledDepth = this.resampleDepthGrid(
      depthGrid,
      depthGridConfig,
      gridConfig,
    );

    const sourceAngles: number[] = [];
    for (let dir = 0; dir < directionCount; dir++) {
      sourceAngles.push((dir / directionCount) * Math.PI * 2);
    }

    const directionIndices = Array.from(
      { length: directionCount },
      (_, i) => i,
    );
    const batches = distributeWork(directionIndices, pool.getWorkerCount());

    const serializableConfig = toSerializableGridConfig(gridConfig);
    const serializableDepthConfig: SerializableDepthGridConfig = {
      originX: gridConfig.originX,
      originY: gridConfig.originY,
      cellSize: gridConfig.cellSize,
      cellsX: gridConfig.cellsX,
      cellsY: gridConfig.cellsY,
    };

    const scaledWindConfig = scaleDecayForCellSize(
      WIND_PROPAGATION_CONFIG,
      gridConfig.cellSize,
    );
    const propagationConfig: SerializablePropagationConfig = {
      directFlowFactor: scaledWindConfig.directFlowFactor,
      lateralSpreadFactor: scaledWindConfig.lateralSpreadFactor,
      decayFactor: scaledWindConfig.decayFactor,
      maxIterations: scaledWindConfig.maxIterations,
      convergenceThreshold: scaledWindConfig.convergenceThreshold,
    };

    const requests: WindWorkerRequest[] = batches.map((directions) => ({
      type: "compute" as const,
      batchId: 0,
      directions,
      gridConfig: serializableConfig,
      propagationConfig,
      depthGrid: resampledDepth,
      depthGridConfig: serializableDepthConfig,
      sourceAngles: directions.map((dir) => sourceAngles[dir]),
    }));

    const task = pool.run({
      batches: requests,
      combineResults: (results) => {
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
        return results[0];
      },
      getTransferables: () => [],
      onProgress: (p) => {
        this.windProgress = p;
      },
    });

    await task.promise;
    this.windProgress = 1;

    return grid;
  }

  @on("destroy")
  onDestroy() {
    this.depthTexture?.destroy();
    this.depthTexture = null;

    this.windWorkerPool?.terminate();
    this.windWorkerPool = null;
  }
}
