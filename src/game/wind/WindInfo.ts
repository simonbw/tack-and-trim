/**
 * Wind physics data provider with GPU acceleration.
 *
 * Provides a query interface for wind velocity at any world position.
 * Supports hybrid GPU/CPU computation:
 * - GPU tiles provide wind data for in-viewport queries (faster)
 * - CPU fallback for out-of-viewport queries (consistent)
 */

import { createNoise3D, NoiseFunction3D } from "simplex-noise";
import BaseEntity from "../../core/entity/BaseEntity";
import Game from "../../core/Game";
import { profile } from "../../core/util/Profiler";
import type {
  StatsProvider,
  StatsSection,
} from "../../core/util/stats-overlay/StatsProvider";
import { V, V2d } from "../../core/Vector";
import type { Wind } from "../Wind";
import {
  computeBaseWindAtPoint,
  WindComputeParams,
} from "./cpu/WindComputeCPU";
import { WindTileManager } from "./tiles/WindTileManager";
import { WindTileReadbackPool } from "./tiles/WindTileReadbackPool";
import { DEFAULT_WIND_TILE_CONFIG } from "./tiles/WindTileTypes";
import { isWindQuerier } from "./WindQuerier";
import type { GPUSailData, GPUTurbulenceData } from "./webgpu/WindModifierData";
import {
  WindComputePipelineGPU,
  WindViewport,
} from "./webgpu/WindComputePipelineGPU";

/**
 * Wind velocity at a given point.
 */
export interface WindState {
  /** Combined wind velocity (base + modifiers) */
  velocity: V2d;
}

/**
 * Wind physics data provider.
 */
export class WindInfo extends BaseEntity implements StatsProvider {
  id = "windInfo";
  tags = ["statsProvider"];

  /**
   * Get the WindInfo entity from a game instance.
   */
  static fromGame(game: Game): WindInfo | null {
    return game.entities.getById("windInfo") as WindInfo | null;
  }

  // GPU compute pipeline
  private pipeline: WindComputePipelineGPU | null = null;

  // Tile system
  private tileManager: WindTileManager;
  private tileReadbackPool: WindTileReadbackPool | null = null;

  // CPU fallback noise functions
  private speedNoise: NoiseFunction3D = createNoise3D();
  private angleNoise: NoiseFunction3D = createNoise3D();

  // Cache base wind reference
  private wind: Wind | null = null;

  // Track initialization state
  private gpuInitialized = false;

  constructor() {
    super();
    this.tileManager = new WindTileManager();
  }

  onAdd() {
    this.wind = this.game!.entities.getById("wind") as Wind | null;
  }

  /**
   * Initialize GPU resources.
   * Call after entity is added and WebGPU is available.
   */
  async initGPU(): Promise<void> {
    if (this.gpuInitialized) return;

    const config = DEFAULT_WIND_TILE_CONFIG;

    // Initialize compute pipeline
    this.pipeline = new WindComputePipelineGPU();
    await this.pipeline.init();

    // Initialize readback pool
    this.tileReadbackPool = new WindTileReadbackPool(
      config.maxTilesPerFrame,
      config.tileResolution,
    );
    await this.tileReadbackPool.init();

    this.gpuInitialized = true;
  }

  /**
   * Complete pending readbacks from previous frame.
   * Call at start of tick.
   */
  async completeReadbacks(): Promise<void> {
    if (this.tileReadbackPool) {
      await this.tileReadbackPool.completeAllReadbacks();
    }
  }

  /**
   * Collect query forecasts from all WindQuerier entities.
   * Call during tile selection phase.
   */
  @profile
  collectQueryForecasts(): void {
    this.tileManager.resetScores();

    const queriers = this.game!.entities.getTagged("windQuerier");
    for (const entity of queriers) {
      if (isWindQuerier(entity)) {
        const forecast = entity.getWindQueryForecast();
        if (forecast) {
          this.tileManager.accumulateScore(forecast);
        }
      }
    }
  }

  /**
   * Select and compute wind tiles for this frame.
   * Call after collecting forecasts.
   */
  @profile
  computeTiles(): void {
    if (!this.pipeline || !this.tileReadbackPool || !this.wind) return;

    const currentTime = this.game!.elapsedUnpausedTime;

    // Get GPU profiler for timing
    const gpuProfiler = this.game?.renderer.getGpuProfiler();

    // Select tiles to compute
    const tiles = this.tileManager.selectTilesToCompute(currentTime);

    // Assign buffers to tiles
    this.tileReadbackPool.assignBuffersToTiles(tiles);

    // Collect modifier data
    const sails = this.collectGPUSailData();
    const turbulence = this.collectGPUTurbulenceData();

    // Get base wind velocity
    const baseWind = V(
      this.wind.getSpeed() * Math.cos(this.wind.getAngle()),
      this.wind.getSpeed() * Math.sin(this.wind.getAngle()),
    );

    // Compute each tile
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];
      const viewport: WindViewport = {
        left: tile.bounds.minX,
        top: tile.bounds.minY,
        width: tile.bounds.maxX - tile.bounds.minX,
        height: tile.bounds.maxY - tile.bounds.minY,
      };

      // Run GPU compute with profiler
      this.pipeline.update(
        viewport,
        currentTime,
        baseWind,
        sails,
        turbulence,
        gpuProfiler,
      );

      // Initiate readback
      const texture = this.pipeline.getWindTexture();
      if (texture) {
        this.tileReadbackPool.initiateReadback(i, texture, {
          left: viewport.left,
          top: viewport.top,
          width: viewport.width,
          height: viewport.height,
          time: currentTime,
        });
      }

      tile.lastComputedTime = currentTime;
    }
  }

  /**
   * Get wind velocity at a given world position.
   * Uses GPU tiles when available, falls back to CPU.
   */
  getVelocityAtPoint(point: V2d): V2d | null {
    if (!this.gpuInitialized || !this.tileReadbackPool || !this.wind) {
      return null;
    }

    // Try tile lookup
    const tile = this.tileManager.findTileForPoint(point[0], point[1]);
    if (tile) {
      const result = this.tileReadbackPool.sampleAtWorldPoint(
        tile,
        point[0],
        point[1],
      );
      if (result) {
        // GPU returns combined base + modifiers
        return V(result.velocityX, result.velocityY);
      }
    }

    // CPU fallback
    return this.computeCPUWind(point);
  }

  /**
   * CPU fallback for wind computation.
   */
  private computeCPUWind(point: V2d): V2d | null {
    if (!this.wind) return null;

    const params: WindComputeParams = {
      time: this.game!.elapsedUnpausedTime,
      baseVelocity: V(
        this.wind.getSpeed() * Math.cos(this.wind.getAngle()),
        this.wind.getSpeed() * Math.sin(this.wind.getAngle()),
      ),
      speedNoise: this.speedNoise,
      angleNoise: this.angleNoise,
    };

    const result = computeBaseWindAtPoint(point[0], point[1], params);
    return V(result.velocityX, result.velocityY);
  }

  /**
   * Collect sail wind effect data for GPU compute.
   */
  private collectGPUSailData(): GPUSailData[] {
    const sails: GPUSailData[] = [];
    const modifiers = this.game!.entities.getTagged("windModifier");

    for (const entity of modifiers) {
      // Check if entity has GPU data method
      const maybeProvider = entity as unknown as {
        getGPUSailData?: () => GPUSailData | null;
      };
      if (typeof maybeProvider.getGPUSailData === "function") {
        const data = maybeProvider.getGPUSailData();
        if (data) {
          sails.push(data);
        }
      }
    }

    return sails;
  }

  /**
   * Collect turbulence particle data for GPU compute.
   */
  private collectGPUTurbulenceData(): GPUTurbulenceData[] {
    const particles: GPUTurbulenceData[] = [];
    const turbulenceEntities = this.game!.entities.getTagged("turbulence");

    for (const entity of turbulenceEntities) {
      // Check if entity has GPU data method
      const maybeProvider = entity as unknown as {
        getGPUTurbulenceData?: () => GPUTurbulenceData | null;
      };
      if (typeof maybeProvider.getGPUTurbulenceData === "function") {
        const data = maybeProvider.getGPUTurbulenceData();
        if (data) {
          particles.push(data);
        }
      }
    }

    return particles;
  }

  /**
   * StatsProvider implementation.
   */
  getStatsSection(): StatsSection | null {
    if (!this.tileReadbackPool) return null;

    const activeTiles = this.tileManager.getActiveTileCount();
    const tileHits = this.tileReadbackPool.stats.tileHits;
    const cpuFallbacks = this.tileReadbackPool.stats.cpuFallbacks;
    const total = tileHits + cpuFallbacks;

    if (total === 0 && activeTiles === 0) return null;

    // Get GPU timing
    const gpuMs = this.game?.renderer.getGpuMs("windCompute") ?? 0;

    const items: StatsSection["items"] = [];

    // GPU time (if available)
    if (gpuMs > 0) {
      items.push({
        label: "GPU Time",
        value: `${gpuMs.toFixed(2)}ms`,
        color: gpuMs > 2 ? "warning" : "success",
      });
    }

    items.push({
      label: "Active Tiles",
      value: `${activeTiles}`,
      color: activeTiles > 0 ? "success" : "muted",
    });

    if (total > 0) {
      const gpuPercent = (tileHits / total) * 100;
      items.push({
        label: "Tile Hits",
        value: `${gpuPercent.toFixed(0)}% (${tileHits}/${total})`,
        color:
          gpuPercent > 90 ? "success" : gpuPercent > 50 ? "warning" : "error",
      });

      if (cpuFallbacks > 0) {
        items.push({
          label: "CPU Fallbacks",
          value: `${cpuFallbacks}`,
          indent: true,
          color: "muted",
        });
      }
    }

    return {
      title: "Wind Physics",
      items,
    };
  }

  /**
   * Reset per-frame stats counters.
   */
  resetStatsCounters(): void {
    this.tileReadbackPool?.stats.reset();
  }

  /**
   * Check if GPU is initialized.
   */
  isGPUInitialized(): boolean {
    return this.gpuInitialized;
  }

  /**
   * Get the tile manager.
   */
  getTileManager(): WindTileManager {
    return this.tileManager;
  }

  /**
   * Clean up GPU resources.
   */
  onDestroy() {
    this.pipeline?.destroy();
    this.tileReadbackPool?.destroy();
    this.pipeline = null;
    this.tileReadbackPool = null;
    this.gpuInitialized = false;
  }
}
