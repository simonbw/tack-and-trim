/**
 * Wind physics data provider with GPU acceleration.
 *
 * Provides a query interface for wind velocity at any world position.
 * Supports hybrid GPU/CPU computation:
 * - GPU tiles provide wind data for in-viewport queries (faster)
 * - CPU fallback for out-of-viewport queries (consistent)
 *
 * Also provides control methods for setting base wind direction/speed.
 */

import { createNoise3D, NoiseFunction3D } from "simplex-noise";
import BaseEntity from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import Game from "../../core/Game";
import { profile } from "../../core/util/Profiler";
import { SparseSpatialHash } from "../../core/util/SparseSpatialHash";
import { V, V2d } from "../../core/Vector";
import { DataTileComputePipeline } from "../datatiles/DataTileComputePipeline";
import type { DataTileReadbackConfig } from "../datatiles/DataTileReadbackBuffer";
import type {
  DataTileGridConfig,
  QueryForecast,
} from "../datatiles/DataTileTypes";
import { WindModifier } from "../WindModifier";
import {
  computeBaseWindAtPoint,
  WindComputeParams,
} from "./cpu/WindComputeCPU";
import { WindTileCompute } from "./webgpu/WindTileCompute";
import { WIND_VELOCITY_SCALE } from "./WindConstants";

/**
 * Wind velocity sample type.
 */
export interface WindVelocity {
  velocityX: number;
  velocityY: number;
}

/**
 * Wind velocity at a given point.
 */
export interface WindState {
  /** Combined wind velocity (base + modifiers) */
  velocity: V2d;
}

/**
 * Wind tile grid configuration.
 */
const WIND_TILE_CONFIG: DataTileGridConfig = {
  tileSize: 64,
  tileResolution: 256,
  maxTilesPerFrame: 64,
  minScoreThreshold: 1,
};

/**
 * Wind readback buffer configuration.
 */
const WIND_READBACK_CONFIG: DataTileReadbackConfig<WindVelocity> = {
  channelCount: 2,
  bytesPerPixel: 8, // rg32float
  label: "Wind",
  texelToSample: (c) => ({ velocityX: c[0], velocityY: c[1] }),
  denormalize: (s) => ({
    velocityX: (s.velocityX - 0.5) * WIND_VELOCITY_SCALE,
    velocityY: (s.velocityY - 0.5) * WIND_VELOCITY_SCALE,
  }),
};

/**
 * Wind physics data provider.
 */
export class WindInfo extends BaseEntity {
  id = "windInfo";
  tickLayer = "environment" as const;

  /**
   * Get the WindInfo entity from a game instance.
   */
  static fromGame(game: Game): WindInfo | null {
    return game.entities.getById("windInfo") as WindInfo | null;
  }

  // Base wind velocity - the global wind direction and speed
  private baseVelocity: V2d = V(11, 11); // ~15 ft/s (~9 kts), NW breeze

  // Tile pipeline for physics queries (using shared abstraction)
  private tilePipeline: DataTileComputePipeline<
    WindVelocity,
    WindTileCompute
  > | null = null;

  // CPU fallback noise functions
  private speedNoise: NoiseFunction3D = createNoise3D();
  private angleNoise: NoiseFunction3D = createNoise3D();

  // Spatial hash for wind modifier queries (CPU fallback)
  private spatialHash = new SparseSpatialHash<WindModifier>((m) =>
    m.getWindModifierAABB(),
  );

  // Track initialization state
  private gpuInitialized = false;

  @on("afterAdded")
  onAfterAdded() {
    // Initialize GPU resources after entity is fully added
    this.initGPU().catch(console.error);
  }

  /**
   * Complete tile readbacks and rebuild spatial hash.
   */
  @on("tick")
  @profile
  onTick() {
    // Complete readbacks from previous frame
    if (this.tilePipeline) {
      this.tilePipeline.completeReadbacks().catch((error) => {
        console.warn("Wind tile readback error:", error);
      });
    }

    // Rebuild spatial hash from all wind modifiers (for CPU fallback)
    this.spatialHash.clear();
    const modifiers = this.game!.entities.getTagged("windModifier");
    for (const modifier of modifiers) {
      this.spatialHash.add(modifier as unknown as WindModifier);
    }
  }

  /**
   * Compute tiles after physics.
   */
  @on("afterPhysics")
  @profile
  onAfterPhysics() {
    if (!this.tilePipeline || !this.gpuInitialized) return;

    this.collectQueryForecasts();
    this.computeTiles();
  }

  /**
   * Initialize GPU resources.
   * Call after entity is added and WebGPU is available.
   */
  async initGPU(): Promise<void> {
    if (this.gpuInitialized) return;

    // Initialize tile pipeline with composition pattern
    // This creates one WindTileCompute per tile slot
    this.tilePipeline = new DataTileComputePipeline<
      WindVelocity,
      WindTileCompute
    >(
      WIND_TILE_CONFIG,
      WIND_READBACK_CONFIG,
      (resolution) => new WindTileCompute(resolution),
    );
    await this.tilePipeline.init();

    this.gpuInitialized = true;
  }

  /**
   * Collect query forecasts from all windQuerier-tagged entities.
   */
  @profile
  private collectQueryForecasts(): void {
    if (!this.tilePipeline) return;

    this.tilePipeline.resetScores();

    const queriers = this.game!.entities.getTagged("windQuerier");
    for (const entity of queriers) {
      const forecast = (
        entity as { getQueryForecast?(): QueryForecast | null }
      ).getQueryForecast?.();
      if (forecast) {
        this.tilePipeline.accumulateForecast(forecast);
      }
    }
  }

  /**
   * Select and compute wind tiles for this frame.
   */
  @profile
  private computeTiles(): void {
    if (!this.tilePipeline) return;

    const currentTime = this.game!.elapsedUnpausedTime;
    const gpuProfiler = this.game?.renderer.getGpuProfiler();

    // Get base wind velocity components
    const baseWindX = this.baseVelocity.x;
    const baseWindY = this.baseVelocity.y;

    // Compute tiles using callback pattern for domain-specific compute
    this.tilePipeline.computeTiles(
      currentTime,
      (compute, viewport) => {
        compute.setBaseWind(baseWindX, baseWindY);
        compute.runCompute(
          viewport.time,
          viewport.left,
          viewport.top,
          viewport.width,
          viewport.height,
        );
      },
      gpuProfiler,
    );
  }

  /**
   * Get wind velocity at a given world position.
   * Uses GPU tiles when available, falls back to CPU.
   */
  getVelocityAtPoint(point: V2d): V2d {
    // Try GPU path if initialized
    if (this.gpuInitialized && this.tilePipeline) {
      const result = this.tilePipeline.sampleAtWorldPoint(point[0], point[1]);
      if (result) {
        return V(result.velocityX, result.velocityY);
      }
    }

    // CPU fallback: base wind + modifiers
    const velocity = this.computeCPUBaseWind(point);

    // Query spatial hash for modifiers that might affect this point
    for (const modifier of this.spatialHash.queryPoint(point)) {
      velocity.iadd(modifier.getWindVelocityContribution(point));
    }

    return velocity;
  }

  /**
   * Get base wind velocity at a point (without modifier contributions).
   * Uses GPU path if available, CPU fallback otherwise.
   */
  getBaseVelocityAtPoint(point: V2d): V2d {
    // For now, always use CPU computation since GPU doesn't distinguish base vs modified
    return this.computeCPUBaseWind(point);
  }

  /**
   * CPU fallback for base wind computation.
   */
  private computeCPUBaseWind(point: V2d): V2d {
    const params: WindComputeParams = {
      time: this.game!.elapsedUnpausedTime,
      baseVelocity: this.baseVelocity.clone(),
      speedNoise: this.speedNoise,
      angleNoise: this.angleNoise,
    };

    const result = computeBaseWindAtPoint(point[0], point[1], params);
    return V(result.velocityX, result.velocityY);
  }

  // ==========================================
  // Wind control methods (moved from Wind.ts)
  // ==========================================

  /**
   * Set the base wind velocity directly.
   */
  setVelocity(velocity: V2d): void {
    this.baseVelocity.set(velocity);
  }

  /**
   * Set the base wind from angle and speed.
   * @param angle Wind direction in radians (0 = east, PI/2 = north)
   * @param speed Wind speed in ft/s
   */
  setFromAngleAndSpeed(angle: number, speed: number): void {
    this.baseVelocity.set(Math.cos(angle) * speed, Math.sin(angle) * speed);
  }

  /**
   * Get the base wind speed.
   */
  getSpeed(): number {
    return this.baseVelocity.magnitude;
  }

  /**
   * Get the base wind angle in radians.
   */
  getAngle(): number {
    return this.baseVelocity.angle;
  }

  /**
   * Get all wind modifiers (for visualization).
   */
  getModifiers(): readonly WindModifier[] {
    return this.game!.entities.getTagged(
      "windModifier",
    ) as unknown as readonly WindModifier[];
  }

  // ==========================================
  // Stats and utility methods
  // ==========================================

  /**
   * Get tile statistics for stats panel.
   */
  getTileStats(): {
    activeTiles: number;
    maxTiles: number;
    tileHits: number;
    cpuFallbacks: number;
  } | null {
    if (!this.tilePipeline) return null;
    return {
      activeTiles: this.tilePipeline.getActiveTileCount(),
      maxTiles: this.tilePipeline.getMaxTileCount(),
      tileHits: this.tilePipeline.stats.tileHits,
      cpuFallbacks: this.tilePipeline.stats.cpuFallbacks,
    };
  }

  /**
   * Reset per-frame stats counters.
   */
  resetStatsCounters(): void {
    this.tilePipeline?.stats.reset();
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
  getTileManager() {
    return this.tilePipeline?.getTileManager() ?? null;
  }

  /**
   * Clean up GPU resources.
   */
  @on("destroy")
  onDestroy() {
    this.tilePipeline?.destroy();
    this.tilePipeline = null;
    this.gpuInitialized = false;
  }
}
