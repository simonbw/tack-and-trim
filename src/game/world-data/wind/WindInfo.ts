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
import BaseEntity from "../../../core/entity/BaseEntity";
import { on } from "../../../core/entity/handler";
import Game from "../../../core/Game";
import { profile } from "../../../core/util/Profiler";
import { SparseSpatialHash } from "../../../core/util/SparseSpatialHash";
import { V, V2d } from "../../../core/Vector";
import {
  DataTileComputePipeline,
  DataTilePipelineConfig,
} from "../datatiles/DataTileComputePipeline";
import type { DataTileReadbackConfig } from "../datatiles/DataTileReadbackBuffer";
import type {
  DataTileGridConfig,
  QueryForecast,
  ReadbackViewport,
} from "../datatiles/DataTileTypes";
import { isWindModifier, type WindModifier } from "../../WindModifier";
import {
  computeBaseWindAtPoint,
  WindComputeParams,
} from "./cpu/WindComputeCPU";
import { WindTileCompute } from "./webgpu/WindTileCompute";
import { WIND_VELOCITY_SCALE } from "./WindConstants";
import { isWindQuerier } from "./WindQuerier";

/**
 * Wind velocity sample type.
 */
export interface WindPointData {
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
const WIND_READBACK_CONFIG: DataTileReadbackConfig<WindPointData> = {
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
   * Throws if not found.
   */
  static fromGame(game: Game): WindInfo {
    const windInfo = game.entities.getById("windInfo");
    if (!(windInfo instanceof WindInfo)) {
      throw new Error("WindInfo not found in game");
    }
    return windInfo;
  }

  /**
   * Get the WindInfo entity from a game instance, or undefined if not found.
   */
  static maybeFromGame(game: Game): WindInfo | undefined {
    const windInfo = game.entities.getById("windInfo");
    return windInfo instanceof WindInfo ? windInfo : undefined;
  }

  // Base wind velocity - the global wind direction and speed
  private baseVelocity: V2d = V(11, 11); // ~15 ft/s (~9 kts), NW breeze

  // Tile pipeline for physics queries (created in constructor)
  private pipeline: DataTileComputePipeline<WindPointData, WindTileCompute>;

  // CPU fallback noise functions
  private speedNoise: NoiseFunction3D = createNoise3D();
  private angleNoise: NoiseFunction3D = createNoise3D();

  // Spatial hash for wind modifier queries (CPU fallback)
  private spatialHash = new SparseSpatialHash<WindModifier>((m) =>
    m.getWindModifierAABB(),
  );

  constructor() {
    super();

    // Create pipeline with config - pipeline handles its own lifecycle
    const config: DataTilePipelineConfig<WindPointData, WindTileCompute> = {
      id: "windTilePipeline",
      gridConfig: WIND_TILE_CONFIG,
      readbackConfig: WIND_READBACK_CONFIG,
      computeFactory: (resolution) => new WindTileCompute(resolution),
      getQueryForecasts: () => this.collectForecasts(),
      runCompute: (compute, viewport) => this.runTileCompute(compute, viewport),
    };
    this.pipeline = new DataTileComputePipeline(config);
  }

  @on("afterAdded")
  onAfterAdded() {
    // Add pipeline as child entity - it handles its own lifecycle
    this.addChild(this.pipeline);
  }

  /**
   * Rebuild spatial hash for CPU fallback modifier queries.
   */
  @on("tick")
  @profile
  onTick() {
    this.spatialHash.clear();
    for (const entity of this.game!.entities.getTagged("windModifier")) {
      if (isWindModifier(entity)) {
        this.spatialHash.add(entity);
      }
    }
  }

  /**
   * Collect query forecasts from all windQuerier-tagged entities.
   */
  private *collectForecasts(): Iterable<QueryForecast> {
    for (const entity of this.game!.entities.getTagged("windQuerier")) {
      if (!isWindQuerier(entity)) {
        throw new Error(
          `Entity tagged as "windQuerier" does not implement WindQuerier interface: ${(entity as { id?: string }).id ?? entity}`,
        );
      }
      const forecast = entity.getWindQueryForecast();
      if (forecast) {
        yield forecast;
      }
    }
  }

  /**
   * Run domain-specific compute for a tile.
   */
  private runTileCompute(
    compute: WindTileCompute,
    viewport: ReadbackViewport,
  ): void {
    compute.setBaseWind(this.baseVelocity.x, this.baseVelocity.y);
    compute.runCompute(
      viewport.time,
      viewport.left,
      viewport.top,
      viewport.width,
      viewport.height,
    );
  }

  /**
   * Get wind velocity at a given world position.
   * Uses GPU tiles when available, falls back to CPU.
   */
  getVelocityAtPoint(point: V2d): V2d {
    // Try GPU path
    const result = this.pipeline.sampleAtWorldPoint(point);
    if (result) {
      return V(result.velocityX, result.velocityY);
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
    const result: WindModifier[] = [];
    for (const entity of this.game!.entities.getTagged("windModifier")) {
      if (isWindModifier(entity)) {
        result.push(entity);
      }
    }
    return result;
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
  } {
    return this.pipeline.getTileStats();
  }

  /**
   * Reset per-frame stats counters.
   */
  resetStatsCounters(): void {
    this.pipeline.resetStats();
  }

  /**
   * Check if GPU is initialized.
   */
  isGPUInitialized(): boolean {
    return this.pipeline.isInitialized();
  }

  /**
   * Get the tile manager.
   */
  getTileManager() {
    return this.pipeline.getTileManager();
  }
}
