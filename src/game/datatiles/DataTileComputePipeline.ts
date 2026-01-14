/**
 * Generic data tile computation pipeline.
 *
 * Orchestrates GPU computation and readback for data tiles.
 * Uses factory pattern to create domain-specific compute instances,
 * with one instance per tile slot to avoid texture overwrite issues.
 */

import type { GPUProfiler } from "../../core/graphics/webgpu/GPUProfiler";
import { profile } from "../../core/util/Profiler";
import {
  DataTileReadbackBuffer,
  DataTileReadbackConfig,
} from "./DataTileReadbackBuffer";
import { DataTileManager } from "./DataTileManager";
import type {
  QueryForecast,
  ReadbackViewport,
  DataTile,
  DataTileGridConfig,
} from "./DataTileTypes";

/**
 * Interface for domain-specific GPU compute instances.
 */
export interface DataTileCompute {
  /** Initialize GPU resources */
  init(): Promise<void>;
  /** Get the output texture for readback */
  getOutputTexture(): GPUTexture | null;
  /** Destroy GPU resources */
  destroy(): void;
}

/**
 * Factory function to create compute instances.
 */
export type DataTileComputeFactory<TCompute extends DataTileCompute> = (
  resolution: number,
) => TCompute;

/**
 * Statistics for data tile readback operations.
 */
export interface DataTileReadbackStats {
  /** Number of queries satisfied from tile buffers */
  tileHits: number;
  /** Number of queries that fell back to CPU computation */
  cpuFallbacks: number;
  /** Number of tile readbacks completed this frame */
  readbacksCompleted: number;
  /** Reset counters to zero */
  reset(): void;
}

/**
 * Generic data tile computation pipeline.
 *
 * Creates one compute instance per tile slot to avoid texture overwrite issues.
 * Manages tile selection, GPU computation, and async readback.
 */
export class DataTileComputePipeline<
  TSample,
  TCompute extends DataTileCompute,
> {
  private config: DataTileGridConfig;
  private bufferConfig: DataTileReadbackConfig<TSample>;
  private computeFactory: DataTileComputeFactory<TCompute>;

  // One compute instance per tile slot
  private computes: TCompute[] = [];

  // Readback buffers pool (one per tile slot)
  private buffers: DataTileReadbackBuffer<TSample>[] = [];
  private tileAssignments = new Map<number, DataTile>();

  // Tile manager for scoring and selection
  private tileManager: DataTileManager;

  private initialized = false;

  readonly stats: DataTileReadbackStats = {
    tileHits: 0,
    cpuFallbacks: 0,
    readbacksCompleted: 0,
    reset() {
      this.tileHits = 0;
      this.cpuFallbacks = 0;
      this.readbacksCompleted = 0;
    },
  };

  constructor(
    config: DataTileGridConfig,
    bufferConfig: DataTileReadbackConfig<TSample>,
    computeFactory: DataTileComputeFactory<TCompute>,
  ) {
    this.config = config;
    this.bufferConfig = bufferConfig;
    this.computeFactory = computeFactory;
    this.tileManager = new DataTileManager(config);
  }

  /**
   * Initialize GPU resources.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    // Create one compute instance per tile slot
    for (let i = 0; i < this.config.maxTilesPerFrame; i++) {
      const compute = this.computeFactory(this.config.tileResolution);
      await compute.init();
      this.computes.push(compute);
    }

    // Create readback buffers pool
    for (let i = 0; i < this.config.maxTilesPerFrame; i++) {
      const buffer = new DataTileReadbackBuffer<TSample>(
        this.config.tileResolution,
        this.bufferConfig,
      );
      await buffer.init();
      this.buffers.push(buffer);
    }

    this.initialized = true;
  }

  /**
   * Accumulate a query forecast for tile scoring.
   */
  accumulateForecast(forecast: QueryForecast): void {
    this.tileManager.accumulateScore(forecast);
  }

  /**
   * Reset scores for new frame.
   */
  resetScores(): void {
    this.tileManager.resetScores();
  }

  /**
   * Compute tiles for this frame.
   *
   * @param time Current game time
   * @param runCompute Callback to run domain-specific compute for each tile
   * @param gpuProfiler Optional GPU profiler
   */
  computeTiles(
    time: number,
    runCompute: (compute: TCompute, viewport: ReadbackViewport) => void,
    gpuProfiler?: GPUProfiler | null,
  ): void {
    if (!this.initialized) return;

    // Select tiles to compute
    const tiles = this.tileManager.selectTilesToCompute(time);

    // Assign buffers to tiles
    this.assignBuffersToTiles(tiles);

    // Compute each tile
    for (const tile of tiles) {
      if (tile.bufferIndex < 0 || tile.bufferIndex >= this.computes.length) {
        continue;
      }

      const compute = this.computes[tile.bufferIndex];
      const viewport: ReadbackViewport = {
        left: tile.bounds.minX,
        top: tile.bounds.minY,
        width: tile.bounds.maxX - tile.bounds.minX,
        height: tile.bounds.maxY - tile.bounds.minY,
        time,
      };

      // Run domain-specific compute
      runCompute(compute, viewport);

      // Initiate readback
      const outputTexture = compute.getOutputTexture();
      if (outputTexture) {
        this.buffers[tile.bufferIndex].initiateReadback(
          outputTexture,
          viewport,
          gpuProfiler,
        );
      }

      tile.lastComputedTime = time;
    }
  }

  /**
   * Assign buffers to tiles for this frame.
   */
  private assignBuffersToTiles(tiles: DataTile[]): void {
    // Clear old assignments
    for (const tile of this.tileAssignments.values()) {
      tile.bufferIndex = -1;
    }
    this.tileAssignments.clear();

    // Assign buffers to new tiles
    for (let i = 0; i < Math.min(tiles.length, this.buffers.length); i++) {
      tiles[i].bufferIndex = i;
      this.tileAssignments.set(i, tiles[i]);
    }
  }

  /**
   * Complete all pending readbacks.
   * Should be called at the start of the next frame.
   */
  @profile
  async completeReadbacks(): Promise<void> {
    // Only process buffers with pending work to avoid async overhead
    const pending: Promise<boolean>[] = [];
    for (const buffer of this.buffers) {
      if (buffer.hasPendingReadback()) {
        pending.push(buffer.completeReadback());
      }
    }

    if (pending.length === 0) {
      this.stats.readbacksCompleted = 0;
      return;
    }

    const results = await Promise.all(pending);
    this.stats.readbacksCompleted = results.filter(Boolean).length;
  }

  /**
   * Sample from the tile at a world point.
   * Returns null if point is not in an active tile.
   */
  sampleAtWorldPoint(worldX: number, worldY: number): TSample | null {
    const tile = this.tileManager.findTileForPoint(worldX, worldY);
    if (!tile || tile.bufferIndex < 0) {
      return null;
    }

    const buffer = this.buffers[tile.bufferIndex];
    if (!buffer) return null;

    const result = buffer.sampleAt(worldX, worldY);
    if (result) {
      this.stats.tileHits++;
    }
    return result;
  }

  /**
   * Get the tile manager for external access (e.g., stats).
   */
  getTileManager(): DataTileManager {
    return this.tileManager;
  }

  /**
   * Get the configuration.
   */
  getConfig(): DataTileGridConfig {
    return this.config;
  }

  /**
   * Check if initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get active tile count.
   */
  getActiveTileCount(): number {
    return this.tileManager.getActiveTileCount();
  }

  /**
   * Get max tile count from config.
   */
  getMaxTileCount(): number {
    return this.config.maxTilesPerFrame;
  }

  /**
   * Destroy GPU resources.
   */
  destroy(): void {
    for (const compute of this.computes) {
      compute.destroy();
    }
    this.computes = [];

    for (const buffer of this.buffers) {
      buffer.destroy();
    }
    this.buffers = [];

    this.tileAssignments.clear();
    this.tileManager.clear();
    this.initialized = false;
  }
}
