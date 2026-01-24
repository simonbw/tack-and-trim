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
import {
  TerrainRenderPipeline,
  TerrainViewport,
} from "../../surface-rendering/TerrainRenderPipeline";
import type { TerrainDefinition } from "../terrain/LandMass";
import { TerrainInfo } from "../terrain/TerrainInfo";
import {
  createGridConfig,
  FLOATS_PER_CELL,
  InfluenceFieldGrid,
} from "./InfluenceFieldGrid";
import {
  DEFAULT_SWELL_INFLUENCE,
  DEFAULT_WIND_INFLUENCE,
  type DepthGridConfig,
  type InfluenceGridConfig,
  type SwellInfluence,
  type WindInfluence,
} from "./InfluenceFieldTypes";
import { SwellPropagationCompute } from "./propagation/gpu/SwellPropagationCompute";
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

/** Resolution of the depth texture used for land/water detection (pixels) */
const DEPTH_TEXTURE_SIZE = 256;

/**
 * Progress for individual computation tasks.
 */
export interface TaskProgress {
  wind: number;
  swell: number;
  fetch: number;
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
  depthGrid: Float32Array;
  depthGridConfig: SerializableDepthGridConfig;
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
  depthGrid: Float32Array;
  depthGridConfig: SerializableDepthGridConfig;
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
  depthGrid: Float32Array;
  depthGridConfig: SerializableDepthGridConfig;
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

  // GPU textures (created after propagation)
  private swellTexture: GPUTexture | null = null;
  private fetchTexture: GPUTexture | null = null;
  private depthTexture: GPUTexture | null = null;
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
   * Compute all influence fields in parallel using Web Workers.
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

    // Generate depth grid using TerrainRenderPipeline (GPU-based, uses same terrain as rendering)
    const { depthGrid, depthGridConfig } = await this.computeDepthGrid(
      terrainDef,
      minX,
      minY,
      maxX - minX,
      maxY - minY,
    );
    this.depthGrid = depthGrid;
    this.depthGridConfig = depthGridConfig;

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

    // Start all three computations in parallel
    const windPromise = this.computeWindField(
      depthGrid,
      depthGridConfig,
      windGridConfig,
    );
    const swellPromise = this.computeSwellField(
      depthGrid,
      depthGridConfig,
      swellGridConfig,
    );
    const fetchPromise = this.computeFetchField(
      depthGrid,
      depthGridConfig,
      fetchGridConfig,
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

    // Create GPU textures
    if (!getWebGPU().isInitialized) {
      throw new Error(
        "WebGPU is not initialized; cannot create influence field textures",
      );
    }

    this.createGPUTextures(swellGrid, fetchGrid);

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
  ): Promise<InfluenceFieldGrid> {
    return this.computeWindFieldWithPool(
      this.windWorkerPool!,
      depthGrid,
      depthGridConfig,
      gridConfig,
    );
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
    depthGrid: Float32Array,
    depthGridConfig: DepthGridConfig,
    gridConfig: InfluenceGridConfig,
  ): Promise<InfluenceFieldGrid> {
    // Try GPU path first if WebGPU is available and not forced to CPU
    if (
      getWebGPU().isInitialized &&
      !InfluenceFieldManager.shouldForceCPUSwell()
    ) {
      try {
        return await this.computeSwellFieldGPU(
          depthGrid,
          depthGridConfig,
          gridConfig,
        );
      } catch (error) {
        console.warn(
          "[InfluenceFieldManager] GPU swell computation failed, falling back to workers:",
          error,
        );
      }
    }

    // Fall back to worker pool
    return this.computeSwellFieldWorkers(
      depthGrid,
      depthGridConfig,
      gridConfig,
    );
  }

  /**
   * Compute swell influence field using GPU compute shaders.
   *
   * Uses optimized 3D dispatch to process ALL 32 direction/wavelength
   * combinations simultaneously, reducing GPU overhead dramatically.
   */
  private async computeSwellFieldGPU(
    depthGrid: Float32Array,
    depthGridConfig: DepthGridConfig,
    gridConfig: InfluenceGridConfig,
  ): Promise<InfluenceFieldGrid> {
    const { directionCount, cellsX, cellsY } = gridConfig;

    // Create output grid
    const grid = new InfluenceFieldGrid(gridConfig);

    // Resample depth grid to influence grid resolution
    const resampledDepth = this.resampleDepthGrid(
      depthGrid,
      depthGridConfig,
      gridConfig,
    );

    // Initialize GPU compute with 3D buffer support
    const compute = new SwellPropagationCompute();
    await compute.init(
      { cellsX, cellsY, directionCount },
      resampledDepth,
      depthGridConfig,
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

    compute.destroy();
    this.swellProgress = 1;

    return grid;
  }

  /**
   * Compute swell influence field using worker pool.
   */
  private async computeSwellFieldWorkers(
    depthGrid: Float32Array,
    depthGridConfig: DepthGridConfig,
    gridConfig: InfluenceGridConfig,
  ): Promise<InfluenceFieldGrid> {
    return this.computeSwellFieldWorkersWithPool(
      this.swellWorkerPool!,
      depthGrid,
      depthGridConfig,
      gridConfig,
    );
  }

  /**
   * Compute fetch map using worker pool.
   */
  private async computeFetchField(
    depthGrid: Float32Array,
    depthGridConfig: DepthGridConfig,
    gridConfig: InfluenceGridConfig,
  ): Promise<InfluenceFieldGrid> {
    return this.computeFetchFieldWithPool(
      this.fetchWorkerPool!,
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
    const textureSize = DEPTH_TEXTURE_SIZE;
    const device = getWebGPU().device;

    // Create a dedicated pipeline for depth readback
    const depthPipeline = new TerrainRenderPipeline(textureSize);
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
    const bytesPerRow = textureSize * 16; // rgba32float = 16 bytes per pixel
    const stagingBuffer = device.createBuffer({
      size: bytesPerRow * textureSize,
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
      { width: textureSize, height: textureSize },
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
    const depthGrid = new Float32Array(textureSize * textureSize);
    for (let i = 0; i < textureSize * textureSize; i++) {
      depthGrid[i] = mappedData[i * 4]; // R channel
    }

    // Cleanup the render pipeline (we've read back the data)
    depthPipeline.destroy();

    // Create a persistent depth texture for the water shader (r32float)
    this.depthTexture = device.createTexture({
      size: { width: textureSize, height: textureSize },
      format: "r32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      label: "Depth Grid Texture",
    });

    // Upload depth data to texture
    device.queue.writeTexture(
      { texture: this.depthTexture },
      depthGrid,
      { bytesPerRow: textureSize * 4 }, // 4 bytes per r32float
      { width: textureSize, height: textureSize },
    );

    const depthGridConfig: DepthGridConfig = {
      originX,
      originY,
      cellSize: width / textureSize,
      cellsX: textureSize,
      cellsY: textureSize,
    };

    return { depthGrid, depthGridConfig };
  }

  /**
   * Resample depth grid to match influence grid resolution.
   * Uses bilinear interpolation for smooth results.
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
        // World position at cell center
        const worldX = originX + (x + 0.5) * cellSize;
        const worldY = originY + (y + 0.5) * cellSize;

        // Sample from depth grid with bilinear interpolation
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

    // Convert to grid coordinates (0 to cellsX-1, 0 to cellsY-1)
    const gx = (worldX - originX) / cellSize - 0.5;
    const gy = (worldY - originY) / cellSize - 0.5;

    // Clamp to grid bounds
    const x0 = Math.max(0, Math.min(cellsX - 2, Math.floor(gx)));
    const y0 = Math.max(0, Math.min(cellsY - 2, Math.floor(gy)));
    const x1 = x0 + 1;
    const y1 = y0 + 1;

    // Interpolation weights
    const fx = Math.max(0, Math.min(1, gx - x0));
    const fy = Math.max(0, Math.min(1, gy - y0));

    // Sample four corners
    const v00 = depthGrid[y0 * cellsX + x0];
    const v10 = depthGrid[y0 * cellsX + x1];
    const v01 = depthGrid[y1 * cellsX + x0];
    const v11 = depthGrid[y1 * cellsX + x1];

    // Bilinear interpolation
    const v0 = v00 * (1 - fx) + v10 * fx;
    const v1 = v01 * (1 - fx) + v11 * fx;
    return v0 * (1 - fy) + v1 * fy;
  }

  /**
   * Defer texture destruction by 2 animation frames to ensure GPU commands complete.
   * This prevents "Destroyed texture used in a submit" errors.
   */
  private deferTextureDestruction(texture: GPUTexture | null): void {
    if (!texture) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        texture.destroy();
      });
    });
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
   * Get the depth GPU texture for shoaling/damping calculations.
   * Returns null if not yet initialized or WebGPU not available.
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
   * Recompute influence fields for updated terrain.
   * Keeps existing data available during computation so rendering continues uninterrupted.
   * Dispatches "influenceFieldsReady" when complete.
   */
  async recompute(): Promise<void> {
    // Reset progress
    this.windProgress = 0;
    this.swellProgress = 0;
    this.fetchProgress = 0;

    // Get terrain info (may have changed since last compute)
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

    // Generate depth grid using TerrainRenderPipeline
    const { depthGrid, depthGridConfig } = await this.computeDepthGrid(
      terrainDef,
      minX,
      minY,
      maxX - minX,
      maxY - minY,
    );
    this.depthGrid = depthGrid;
    this.depthGridConfig = depthGridConfig;

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

    // Create new worker pools (don't terminate existing ones yet - they might still be in use)
    const newWindPool = new WorkerPool<WindWorkerRequest, WindWorkerResult>({
      workerUrl: new URL(
        "./propagation/workers/WindWorker.ts",
        import.meta.url,
      ),
      label: "WindWorker-recompute",
    });

    const newSwellPool = new WorkerPool<
      SwellWorkerRequest,
      CombinedSwellWorkerResult
    >({
      workerUrl: new URL(
        "./propagation/workers/SwellWorker.ts",
        import.meta.url,
      ),
      label: "SwellWorker-recompute",
    });

    const newFetchPool = new WorkerPool<FetchWorkerRequest, FetchWorkerResult>({
      workerUrl: new URL(
        "./propagation/workers/FetchWorker.ts",
        import.meta.url,
      ),
      label: "FetchWorker-recompute",
    });

    // Initialize all worker pools in parallel
    await Promise.all([
      newWindPool.initialize(),
      newSwellPool.initialize(),
      newFetchPool.initialize(),
    ]);

    // Compute new grids using the new pools (existing data remains valid during computation)
    const windPromise = this.computeWindFieldWithPool(
      newWindPool,
      depthGrid,
      depthGridConfig,
      windGridConfig,
    );
    const swellPromise = this.computeSwellFieldWithPool(
      newSwellPool,
      depthGrid,
      depthGridConfig,
      swellGridConfig,
    );
    const fetchPromise = this.computeFetchFieldWithPool(
      newFetchPool,
      depthGrid,
      depthGridConfig,
      fetchGridConfig,
    );

    const [newWindGrid, newSwellGrid, newFetchGrid] = await Promise.all([
      windPromise,
      swellPromise,
      fetchPromise,
    ]);

    // Terminate the new worker pools (no longer needed)
    newWindPool.terminate();
    newSwellPool.terminate();
    newFetchPool.terminate();

    // Store references to old textures for cleanup
    const oldSwellTexture = this.swellTexture;
    const oldFetchTexture = this.fetchTexture;

    // Create new GPU textures
    this.createGPUTextures(newSwellGrid, newFetchGrid);

    // Atomically swap grids
    this.windGrid = newWindGrid;
    this.swellGrid = newSwellGrid;
    this.fetchGrid = newFetchGrid;

    // Defer texture destruction by 2 animation frames to ensure GPU commands complete
    this.deferTextureDestruction(oldSwellTexture);
    this.deferTextureDestruction(oldFetchTexture);

    // Mark as initialized (in case this is first compute)
    if (!this.initialized) {
      this.initialized = true;
      if (this.initializationResolve) {
        this.initializationResolve();
      }
    }

    // Signal completion
    this.game.dispatch("influenceFieldsReady", {});
  }

  /**
   * Compute wind influence field using a specific worker pool.
   * Extracted to allow recompute to use its own pool.
   */
  private async computeWindFieldWithPool(
    pool: WorkerPool<WindWorkerRequest, WindWorkerResult>,
    depthGrid: Float32Array,
    depthGridConfig: DepthGridConfig,
    gridConfig: InfluenceGridConfig,
  ): Promise<InfluenceFieldGrid> {
    const { directionCount, cellsX, cellsY } = gridConfig;

    // Create output grid
    const grid = new InfluenceFieldGrid(gridConfig);

    // Resample depth grid to influence grid resolution
    const resampledDepth = this.resampleDepthGrid(
      depthGrid,
      depthGridConfig,
      gridConfig,
    );

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
    const serializableDepthConfig: SerializableDepthGridConfig = {
      originX: gridConfig.originX,
      originY: gridConfig.originY,
      cellSize: gridConfig.cellSize,
      cellsX: gridConfig.cellsX,
      cellsY: gridConfig.cellsY,
    };
    const propagationConfig: SerializablePropagationConfig = {
      directFlowFactor: WIND_PROPAGATION_CONFIG.directFlowFactor,
      lateralSpreadFactor: WIND_PROPAGATION_CONFIG.lateralSpreadFactor,
      decayFactor: WIND_PROPAGATION_CONFIG.decayFactor,
      maxIterations: WIND_PROPAGATION_CONFIG.maxIterations,
      convergenceThreshold: WIND_PROPAGATION_CONFIG.convergenceThreshold,
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

    // Run computation
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

  /**
   * Compute swell influence field using a specific worker pool.
   * Extracted to allow recompute to use its own pool.
   */
  private async computeSwellFieldWithPool(
    pool: WorkerPool<SwellWorkerRequest, CombinedSwellWorkerResult>,
    depthGrid: Float32Array,
    depthGridConfig: DepthGridConfig,
    gridConfig: InfluenceGridConfig,
  ): Promise<InfluenceFieldGrid> {
    // Try GPU path first if WebGPU is available and not forced to CPU
    if (
      getWebGPU().isInitialized &&
      !InfluenceFieldManager.shouldForceCPUSwell()
    ) {
      try {
        return await this.computeSwellFieldGPU(
          depthGrid,
          depthGridConfig,
          gridConfig,
        );
      } catch (error) {
        console.warn(
          "[InfluenceFieldManager] GPU swell computation failed, falling back to workers:",
          error,
        );
      }
    }

    // Fall back to worker pool
    return this.computeSwellFieldWorkersWithPool(
      pool,
      depthGrid,
      depthGridConfig,
      gridConfig,
    );
  }

  /**
   * Compute swell influence field using a specific worker pool.
   */
  private async computeSwellFieldWorkersWithPool(
    pool: WorkerPool<SwellWorkerRequest, CombinedSwellWorkerResult>,
    depthGrid: Float32Array,
    depthGridConfig: DepthGridConfig,
    gridConfig: InfluenceGridConfig,
  ): Promise<InfluenceFieldGrid> {
    const { directionCount, cellsX, cellsY } = gridConfig;

    // Create output grid
    const grid = new InfluenceFieldGrid(gridConfig);

    // Resample depth grid to influence grid resolution
    const resampledDepth = this.resampleDepthGrid(
      depthGrid,
      depthGridConfig,
      gridConfig,
    );

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
    const serializableDepthConfig: SerializableDepthGridConfig = {
      originX: gridConfig.originX,
      originY: gridConfig.originY,
      cellSize: gridConfig.cellSize,
      cellsX: gridConfig.cellsX,
      cellsY: gridConfig.cellsY,
    };
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
      depthGrid: resampledDepth,
      depthGridConfig: serializableDepthConfig,
      sourceAngles: directions.map((dir) => sourceAngles[dir]),
    }));

    // Run computation
    const task = pool.run({
      batches: requests,
      combineResults: (results) => {
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
      getTransferables: () => [],
      onProgress: (p) => {
        this.swellProgress = p;
      },
    });

    await task.promise;
    this.swellProgress = 1;

    return grid;
  }

  /**
   * Compute fetch map using a specific worker pool.
   * Extracted to allow recompute to use its own pool.
   */
  private async computeFetchFieldWithPool(
    pool: WorkerPool<FetchWorkerRequest, FetchWorkerResult>,
    depthGrid: Float32Array,
    depthGridConfig: DepthGridConfig,
    gridConfig: InfluenceGridConfig,
  ): Promise<InfluenceFieldGrid> {
    const { directionCount, cellsX, cellsY } = gridConfig;

    // Create output grid
    const grid = new InfluenceFieldGrid(gridConfig);

    // Resample depth grid to influence grid resolution
    const resampledDepth = this.resampleDepthGrid(
      depthGrid,
      depthGridConfig,
      gridConfig,
    );

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
    const serializableDepthConfig: SerializableDepthGridConfig = {
      originX: gridConfig.originX,
      originY: gridConfig.originY,
      cellSize: gridConfig.cellSize,
      cellsX: gridConfig.cellsX,
      cellsY: gridConfig.cellsY,
    };
    const stepSize = gridConfig.cellSize / 2;

    const requests: FetchWorkerRequest[] = batches.map((directions) => ({
      type: "compute" as const,
      batchId: 0,
      directions,
      gridConfig: serializableConfig,
      depthGrid: resampledDepth,
      depthGridConfig: serializableDepthConfig,
      upwindAngles: directions.map((dir) => upwindAngles[dir]),
      maxFetch: DEFAULT_MAX_FETCH,
      stepSize,
    }));

    // Run computation
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
              grid.data[dstIdx + 0] = result.fetchData[srcIdx + 0];
              grid.data[dstIdx + 1] = result.fetchData[srcIdx + 1];
              grid.data[dstIdx + 2] = result.fetchData[srcIdx + 2];
              grid.data[dstIdx + 3] = result.fetchData[srcIdx + 3];
            }
          }
        }
        return results[0];
      },
      getTransferables: () => [],
      onProgress: (p) => {
        this.fetchProgress = p;
      },
    });

    await task.promise;
    this.fetchProgress = 1;

    return grid;
  }

  @on("destroy")
  onDestroy() {
    // Clean up GPU resources
    this.swellTexture?.destroy();
    this.fetchTexture?.destroy();
    this.depthTexture?.destroy();
    this.swellTexture = null;
    this.fetchTexture = null;
    this.depthTexture = null;
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
