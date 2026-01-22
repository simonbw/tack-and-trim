/**
 * Generic data tile computation pipeline as an Entity.
 *
 * Orchestrates GPU computation and readback for data tiles.
 * Uses factory pattern to create domain-specific compute instances,
 * with one instance per tile slot to avoid texture overwrite issues.
 *
 * Handles its own lifecycle via @on event handlers.
 */

import { BaseEntity } from "../../../core/entity/BaseEntity";
import { on } from "../../../core/entity/handler";
import type { GPUProfiler } from "../../../core/graphics/webgpu/GPUProfiler";
import { profile } from "../../../core/util/Profiler";
import type { V2d } from "../../../core/Vector";
import { DataTileManager } from "./DataTileManager";
import {
  DataTileReadbackBuffer,
  DataTileReadbackConfig,
} from "./DataTileReadbackBuffer";
import type {
  DataTile,
  DataTileGridConfig,
  QueryForecast,
  ReadbackViewport,
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
 * Statistics for data tile operations.
 */
export interface DataTileStats {
  /** Number of queries satisfied from tile buffers */
  tileHits: number;
  /** Number of queries that fell back to CPU computation */
  cpuFallbacks: number;
  /** Number of tile readbacks completed this frame */
  readbacksCompleted: number;
}

/**
 * Configuration for the data tile compute pipeline.
 */
export interface DataTilePipelineConfig<
  TSample,
  TCompute extends DataTileCompute,
> {
  /** Entity id for the pipeline */
  id: string;
  /** Grid configuration (tile size, resolution, etc.) */
  gridConfig: DataTileGridConfig;
  /** Readback buffer configuration */
  readbackConfig: DataTileReadbackConfig<TSample>;
  /** Factory to create compute instances */
  computeFactory: DataTileComputeFactory<TCompute>;
  /** Callback to collect query forecasts from entities */
  getQueryForecasts: () => Iterable<QueryForecast>;
  /** Callback to run domain-specific compute for a tile */
  runCompute: (compute: TCompute, viewport: ReadbackViewport) => void;
  /** Optional: Return false to skip GPU compute (reuse cached buffer data) */
  shouldCompute?: (tile: DataTile) => boolean;
  /** Optional: Called after successful compute to update tracking */
  onComputed?: (tile: DataTile) => void;
}

/**
 * Generic data tile computation pipeline as an Entity.
 *
 * Creates one compute instance per tile slot to avoid texture overwrite issues.
 * Manages tile selection, GPU computation, and async readback.
 */
export class DataTileComputePipeline<
  TSample,
  TCompute extends DataTileCompute,
> extends BaseEntity {
  tickLayer = "environment" as const;

  private pipelineConfig: DataTilePipelineConfig<TSample, TCompute>;

  // One compute instance per tile slot
  private computes: TCompute[] = [];

  // Readback buffers pool (one per tile slot)
  private buffers: DataTileReadbackBuffer<TSample>[] = [];
  private tileAssignments = new Map<number, DataTile>();

  // Tile manager for scoring and selection
  private tileManager: DataTileManager;

  private initialized = false;

  private readonly _stats: DataTileStats = {
    tileHits: 0,
    cpuFallbacks: 0,
    readbacksCompleted: 0,
  };

  constructor(config: DataTilePipelineConfig<TSample, TCompute>) {
    super();
    this.id = config.id;
    this.pipelineConfig = config;
    this.tileManager = new DataTileManager(config.gridConfig);
  }

  /**
   * Get statistics for this pipeline.
   */
  get stats(): Readonly<DataTileStats> {
    return this._stats;
  }

  /**
   * Reset per-frame stats counters.
   */
  resetStats(): void {
    this._stats.tileHits = 0;
    this._stats.cpuFallbacks = 0;
    this._stats.readbacksCompleted = 0;
  }

  /**
   * Initialize GPU resources after entity is added.
   */
  @on("afterAdded")
  async onAfterAdded(): Promise<void> {
    if (this.initialized) return;

    const { gridConfig, readbackConfig, computeFactory } = this.pipelineConfig;

    // Create one compute instance per tile slot
    for (let i = 0; i < gridConfig.maxTilesPerFrame; i++) {
      const compute = computeFactory(gridConfig.tileResolution);
      await compute.init();
      this.computes.push(compute);
    }

    // Create readback buffers pool
    for (let i = 0; i < gridConfig.maxTilesPerFrame; i++) {
      const buffer = new DataTileReadbackBuffer<TSample>(
        gridConfig.tileResolution,
        readbackConfig,
      );
      await buffer.init();
      this.buffers.push(buffer);
    }

    this.initialized = true;
  }

  /**
   * Complete tile readbacks at start of tick.
   */
  @on("tick")
  @profile
  onTick(): void {
    if (!this.initialized) return;

    // Complete readbacks from previous frame
    this.completeReadbacks().catch((error) => {
      console.warn(`${this.id} tile readback error:`, error);
    });
  }

  /**
   * Compute tiles after physics.
   */
  @on("afterPhysics")
  @profile
  onAfterPhysics(): void {
    if (!this.initialized) return;

    const time = this.game.elapsedUnpausedTime;
    const gpuProfiler = this.game.renderer.getGpuProfiler();

    // Collect forecasts via callback
    const forecasts = this.pipelineConfig.getQueryForecasts();

    // Select tiles to compute
    const tiles = this.tileManager.selectTilesFromForecasts(forecasts, time);

    // Assign buffers to tiles
    this.assignBuffersToTiles(tiles);

    // Compute each tile
    for (const tile of tiles) {
      if (tile.bufferIndex < 0 || tile.bufferIndex >= this.computes.length) {
        continue;
      }

      // Check if we should skip compute (domain-specific decision)
      const shouldCompute = this.pipelineConfig.shouldCompute?.(tile) ?? true;
      if (!shouldCompute) {
        continue; // Keep using cached buffer data
      }

      const compute = this.computes[tile.bufferIndex];
      const viewport: ReadbackViewport = {
        left: tile.bounds.minX,
        top: tile.bounds.minY,
        width: tile.bounds.maxX - tile.bounds.minX,
        height: tile.bounds.maxY - tile.bounds.minY,
        time,
      };

      // Run domain-specific compute via callback
      this.pipelineConfig.runCompute(compute, viewport);

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

      // Notify domain code that compute happened
      this.pipelineConfig.onComputed?.(tile);
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
   */
  private async completeReadbacks(): Promise<void> {
    // Only process buffers with pending work to avoid async overhead
    const pending = this.buffers
      .filter((buffer) => buffer.hasPendingReadback())
      .map((buffer) => buffer.completeReadback());

    if (pending.length === 0) {
      this._stats.readbacksCompleted = 0;
      return;
    }

    const results = await Promise.all(pending);
    this._stats.readbacksCompleted = results.filter(Boolean).length;
  }

  /**
   * Sample from the tile at a world point.
   * Returns null if point is not in an active tile.
   */
  sampleAtWorldPoint(point: V2d): TSample | null {
    const tile = this.tileManager.findTileForPoint(point.x, point.y);
    if (!tile || tile.bufferIndex < 0) {
      return null;
    }

    const buffer = this.buffers[tile.bufferIndex];
    if (!buffer) return null;

    const result = buffer.sampleAt(point.x, point.y);
    if (result) {
      this._stats.tileHits++;
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
    return this.pipelineConfig.gridConfig;
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
    return this.pipelineConfig.gridConfig.maxTilesPerFrame;
  }

  /**
   * Get tile statistics for stats panel.
   */
  getTileStats(): {
    activeTiles: number;
    maxTiles: number;
    tileHits: number;
    cpuFallbacks: number;
  } {
    return {
      activeTiles: this.getActiveTileCount(),
      maxTiles: this.getMaxTileCount(),
      tileHits: this._stats.tileHits,
      cpuFallbacks: this._stats.cpuFallbacks,
    };
  }

  /**
   * Clean up GPU resources.
   */
  @on("destroy")
  onDestroy(): void {
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
