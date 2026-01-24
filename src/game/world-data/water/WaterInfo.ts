/**
 * Water physics data provider with GPU acceleration.
 *
 * Provides a query interface for water state at any world position.
 * Supports hybrid GPU/CPU computation:
 * - GPU tiles provide water data (waves + modifiers) for in-viewport queries
 * - CPU fallback for out-of-viewport queries
 */

import { createNoise3D, NoiseFunction3D } from "simplex-noise";
import { BaseEntity } from "../../../core/entity/BaseEntity";
import { on } from "../../../core/entity/handler";
import { Game } from "../../../core/Game";
import { profile } from "../../../core/util/Profiler";
import { SparseSpatialHash } from "../../../core/util/SparseSpatialHash";
import { V, V2d } from "../../../core/Vector";
import { TimeOfDay } from "../../time/TimeOfDay";
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
import { InfluenceFieldManager } from "../influence/InfluenceFieldManager";
import type { InfluenceTextureConfig } from "./webgpu/WaterDataTileCompute";
import { WindInfo } from "../wind/WindInfo";
import {
  computeWaveDataAtPoint,
  WaterComputeParams,
} from "./cpu/WaterComputeCPU";
import { WakeParticle } from "./WakeParticle";
import {
  FULL_FETCH_DISTANCE,
  WATER_HEIGHT_SCALE,
  WATER_VELOCITY_SCALE,
  WAVE_COMPONENTS,
} from "./WaterConstants";
import { isWaterModifier, WaterModifier } from "./WaterModifier";
import { isWaterQuerier } from "./WaterQuerier";
import type { WakeSegmentData } from "./webgpu/WaterComputeBuffers";
import {
  WaterDataTileCompute,
  type WaterPointData,
} from "./webgpu/WaterDataTileCompute";

// Re-export for external consumers
export type { WaterPointData };

/**
 * Viewport bounds for water computation.
 */
export interface Viewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

// Units: ft, ft/s for velocities
// Current variation configuration
const CURRENT_SPATIAL_SCALE = 0.002;
const CURRENT_TIME_SCALE = 0.05;
const CURRENT_SPEED_VARIATION = 0.4;
const CURRENT_ANGLE_VARIATION = 0.5;

// Tide configuration
// Semi-diurnal tide: 2 cycles per day (high at 0h & 12h, low at 6h & 18h)
const DEFAULT_TIDE_RANGE = 4; // ft total range (±2 ft from mean)

// Margin to expand viewport for wake particle filtering (ft)
const WAKE_VIEWPORT_MARGIN = 25;

/**
 * Water state at a given point in the world.
 */
export interface WaterState {
  /** Combined water velocity (currents + waves + wakes) */
  velocity: V2d;
  /** Wave surface displacement at this point */
  surfaceHeight: number;
  /** Rate of height change (dh/dt) in ft/s - positive when water is rising */
  surfaceHeightRate: number;
}

/**
 * Water tile grid configuration.
 */
const WATER_TILE_CONFIG: DataTileGridConfig = {
  tileSize: 64,
  tileResolution: 128,
  maxTilesPerFrame: 64,
  minScoreThreshold: 1,
};

/**
 * Water readback buffer configuration.
 */
const WATER_READBACK_CONFIG: DataTileReadbackConfig<WaterPointData> = {
  channelCount: 4,
  bytesPerPixel: 16, // rgba32float
  label: "WaterPhysics",
  texelToSample: (c) => ({
    height: c[0],
    dhdt: c[1],
    velocityX: c[2],
    velocityY: c[3],
  }),
  denormalize: (s) => ({
    height: (s.height - 0.5) * WATER_HEIGHT_SCALE,
    dhdt: (s.dhdt - 0.5) * WATER_VELOCITY_SCALE,
    velocityX: (s.velocityX - 0.5) * WATER_VELOCITY_SCALE,
    velocityY: (s.velocityY - 0.5) * WATER_VELOCITY_SCALE,
  }),
};

/**
 * Water physics data provider.
 */
export class WaterInfo extends BaseEntity {
  id = "waterInfo";
  tickLayer = "environment" as const;

  /**
   * Get the WaterInfo entity from a game instance.
   * Throws if not found.
   */
  static fromGame(game: Game): WaterInfo {
    const waterInfo = game.entities.getById("waterInfo");
    if (!(waterInfo instanceof WaterInfo)) {
      throw new Error("WaterInfo not found in game");
    }
    return waterInfo;
  }

  /**
   * Get the WaterInfo entity from a game instance, or undefined if not found.
   */
  static maybeFromGame(game: Game): WaterInfo | undefined {
    const waterInfo = game.entities.getById("waterInfo");
    return waterInfo instanceof WaterInfo ? waterInfo : undefined;
  }

  // Tile pipeline for physics queries (created in constructor)
  private pipeline: DataTileComputePipeline<
    WaterPointData,
    WaterDataTileCompute
  >;

  // Current simulation
  private baseCurrentVelocity: V2d = V(1.5, 0.5);
  private speedNoise: NoiseFunction3D = createNoise3D();
  private angleNoise: NoiseFunction3D = createNoise3D();

  // Wave amplitude modulation noise (for CPU fallback)
  private waveAmpModNoise: NoiseFunction3D = createNoise3D();
  private surfaceNoise: NoiseFunction3D = createNoise3D();

  // Spatial hash for CPU fallback modifier queries
  private spatialHash = new SparseSpatialHash<WaterModifier>((m) =>
    m.getWaterModifierAABB(),
  );

  // Cached segment data for current frame
  private cachedSegments: WakeSegmentData[] = [];

  // Influence field manager for terrain effects
  private influenceManager: InfluenceFieldManager | null = null;

  // Track which compute instances have influence textures configured
  private configuredComputes = new WeakSet<WaterDataTileCompute>();

  // Cached influence texture config (set once when textures are available)
  private influenceTextureConfig: InfluenceTextureConfig | null = null;

  // Current tide height offset (updated each tick from TimeOfDay)
  private tideHeight: number = 0;

  constructor() {
    super();

    // Create pipeline with config - pipeline handles its own lifecycle
    const config: DataTilePipelineConfig<WaterPointData, WaterDataTileCompute> =
      {
        id: "waterTilePipeline",
        gridConfig: WATER_TILE_CONFIG,
        readbackConfig: WATER_READBACK_CONFIG,
        computeFactory: (resolution) => new WaterDataTileCompute(resolution),
        getQueryForecasts: () => this.collectForecasts(),
        runCompute: (compute, viewport) =>
          this.runTileCompute(compute, viewport),
      };
    this.pipeline = new DataTileComputePipeline(config);
  }

  @on("afterAdded")
  onAfterAdded() {
    // Add pipeline as child entity - it handles its own lifecycle
    this.addChild(this.pipeline);

    // Get reference to influence field manager (if it exists)
    this.influenceManager =
      InfluenceFieldManager.maybeFromGame(this.game) ?? null;
  }

  /**
   * Rebuild spatial hash for CPU fallback and cache segment data.
   */
  @on("tick")
  @profile
  onTick() {
    // Rebuild spatial hash for CPU fallback
    this.spatialHash.clear();
    for (const entity of this.game.entities.getTagged("waterModifier")) {
      if (isWaterModifier(entity)) {
        this.spatialHash.add(entity);
      }
    }

    // Update tide height from TimeOfDay
    const timeOfDay = TimeOfDay.maybeFromGame(this.game);
    if (timeOfDay) {
      const hour = timeOfDay.getHour();
      // Semi-diurnal: 2 cycles per day (high at 0h & 12h, low at 6h & 18h)
      const tidePhase = (hour / 12) * Math.PI;
      this.tideHeight = Math.sin(tidePhase) * (DEFAULT_TIDE_RANGE / 2);
    }

    // Cache segment data for this frame
    const camera = this.game.camera;
    const worldViewport = camera.getWorldViewport();
    this.cachedSegments = this.collectShaderSegmentData({
      left: worldViewport.left - WAKE_VIEWPORT_MARGIN * 2,
      top: worldViewport.top - WAKE_VIEWPORT_MARGIN * 2,
      width: worldViewport.width + WAKE_VIEWPORT_MARGIN * 4,
      height: worldViewport.height + WAKE_VIEWPORT_MARGIN * 4,
    });
  }

  /**
   * Collect query forecasts from all waterQuerier-tagged entities.
   */
  private *collectForecasts(): Iterable<QueryForecast> {
    for (const entity of this.game.entities.getTagged("waterQuerier")) {
      if (!isWaterQuerier(entity)) {
        throw new Error(
          `Entity tagged as "waterQuerier" does not implement WaterQuerier interface: ${(entity as { id?: string }).id ?? entity}`,
        );
      }
      const forecast = entity.getWaterQueryForecast();
      if (forecast) {
        yield forecast;
      }
    }
  }

  /**
   * Get the base swell direction from dominant wave component.
   * Uses the first (largest) wave component's direction.
   */
  private getBaseSwellDirection(): number {
    return WAVE_COMPONENTS[0][2]; // direction is at index 2
  }

  /**
   * Get the current wind direction from WindInfo.
   */
  private getWindDirection(): number {
    const windInfo = WindInfo.maybeFromGame(this.game);
    return windInfo ? windInfo.getAngle() : 0;
  }

  /**
   * Get the current game time in seconds from TimeOfDay.
   * Falls back to elapsedUnpausedTime if TimeOfDay not available.
   */
  private getGameTime(): number {
    const timeOfDay = TimeOfDay.maybeFromGame(this.game);
    return timeOfDay
      ? timeOfDay.getTimeInSeconds()
      : (this.game.elapsedUnpausedTime ?? 0);
  }

  /**
   * Compute fetch factor from raw fetch distance.
   * Returns 0-1 scale factor for wave amplitude.
   */
  private computeFetchFactor(fetchDistance: number): number {
    if (fetchDistance <= 0) return 0;
    return Math.min(1.0, fetchDistance / FULL_FETCH_DISTANCE);
  }

  /**
   * Try to build influence texture config from influence manager.
   * Returns null if textures aren't available yet.
   */
  private tryBuildInfluenceConfig(): InfluenceTextureConfig | null {
    if (!this.influenceManager) return null;

    const swellTexture = this.influenceManager.getSwellTexture();
    const fetchTexture = this.influenceManager.getFetchTexture();
    const influenceSampler = this.influenceManager.getInfluenceSampler();
    const swellGridConfig = this.influenceManager.getSwellGridConfig();
    const fetchGridConfig = this.influenceManager.getFetchGridConfig();

    if (
      !swellTexture ||
      !fetchTexture ||
      !influenceSampler ||
      !swellGridConfig ||
      !fetchGridConfig
    ) {
      return null;
    }

    return {
      swellTexture,
      fetchTexture,
      influenceSampler,
      swellGridConfig,
      fetchGridConfig,
      waveSourceDirection: this.getBaseSwellDirection(),
    };
  }

  /**
   * Configure influence textures on a compute instance if not already done.
   */
  private configureInfluenceTextures(compute: WaterDataTileCompute): void {
    // Already configured this compute instance?
    if (this.configuredComputes.has(compute)) return;

    // Try to get/build the config
    if (!this.influenceTextureConfig) {
      this.influenceTextureConfig = this.tryBuildInfluenceConfig();
    }

    // If we have a config, set it on the compute
    if (this.influenceTextureConfig) {
      compute.setInfluenceTextures(this.influenceTextureConfig);
      this.configuredComputes.add(compute);
    }
  }

  /**
   * Run domain-specific compute for a tile.
   */
  private runTileCompute(
    compute: WaterDataTileCompute,
    viewport: ReadbackViewport,
  ): void {
    // Ensure influence textures are configured (per-pixel sampling in shader)
    this.configureInfluenceTextures(compute);

    // Set wake segments for modifier computation
    compute.setSegments(this.cachedSegments);

    // Set tide height for this compute pass
    compute.setTideHeight(this.tideHeight);

    // Run the compute (shader does per-pixel influence sampling)
    compute.runCompute(
      viewport.time,
      viewport.left,
      viewport.top,
      viewport.width,
      viewport.height,
    );
  }

  /**
   * Get water state at a given world position.
   * Uses GPU tiles when available, falls back to CPU.
   */
  getStateAtPoint(point: V2d): WaterState {
    return this.getStateAtPointGPU(point) ?? this.getStateAtPointCPU(point);
  }

  private getStateAtPointGPU(point: V2d): WaterState | null {
    const physicsData = this.pipeline.sampleAtWorldPoint(point);
    if (physicsData) {
      return {
        velocity: V(physicsData.velocityX, physicsData.velocityY),
        surfaceHeight: physicsData.height,
        surfaceHeightRate: physicsData.dhdt,
      };
    }

    return null;
  }

  private getStateAtPointCPU(point: V2d): WaterState {
    const t = this.getGameTime() * CURRENT_TIME_SCALE;

    const sx = point.x * CURRENT_SPATIAL_SCALE;
    const sy = point.y * CURRENT_SPATIAL_SCALE;

    const speedScale = 1 + this.speedNoise(sx, sy, t) * CURRENT_SPEED_VARIATION;
    const angleVariance = this.angleNoise(sx, sy, t) * CURRENT_ANGLE_VARIATION;

    const velocity = this.baseCurrentVelocity
      .mul(speedScale)
      .irotate(angleVariance);

    // Build CPU params with influence sampled at query point
    const cpuParams = this.buildCPUParamsForPoint(point);

    // CPU fallback: waves + modifier queries
    const waveData = computeWaveDataAtPoint(point[0], point[1], cpuParams);

    // Add tide height to surface height
    let surfaceHeight = waveData.height + this.tideHeight;
    let surfaceHeightRate = waveData.dhdt;

    for (const modifier of this.spatialHash.queryPoint(point)) {
      const contrib = modifier.getWaterContribution(point);
      velocity.x += contrib.velocityX;
      velocity.y += contrib.velocityY;
      surfaceHeight += contrib.height;
      surfaceHeightRate += contrib.heightRate ?? 0;
    }

    return {
      velocity,
      surfaceHeight,
      surfaceHeightRate,
    };
  }

  /**
   * Build CPU compute params for a specific query point.
   * Samples influence fields at that exact location.
   */
  private buildCPUParamsForPoint(point: V2d): WaterComputeParams {
    const time = this.getGameTime();

    // Default values (no terrain influence)
    let swellEnergyFactor = 1.0;
    let chopEnergyFactor = 1.0;
    let fetchFactor = 1.0;
    let swellDirectionOffset = 0;
    let chopDirectionOffset = 0;

    // Sample influence at query point if manager is available
    if (this.influenceManager) {
      const swellDir = this.getBaseSwellDirection();
      const windDir = this.getWindDirection();

      const swell = this.influenceManager.sampleSwellInfluence(
        point.x,
        point.y,
        swellDir,
      );
      const fetchDistance = this.influenceManager.sampleFetch(
        point.x,
        point.y,
        windDir,
      );

      swellEnergyFactor = swell.longSwell.energyFactor;
      chopEnergyFactor = swell.shortChop.energyFactor;
      fetchFactor = this.computeFetchFactor(fetchDistance);

      // Compute direction offsets from diffraction
      swellDirectionOffset = swell.longSwell.arrivalDirection - swellDir;
      chopDirectionOffset = swell.shortChop.arrivalDirection - windDir;
    }

    return {
      time,
      waveAmpModNoise: this.waveAmpModNoise,
      surfaceNoise: this.surfaceNoise,
      swellEnergyFactor,
      chopEnergyFactor,
      fetchFactor,
      swellDirectionOffset,
      chopDirectionOffset,
    };
  }

  /**
   * Collect wake segment data for GPU compute shader.
   * Filters to particles that intersect the viewport.
   */
  collectShaderSegmentData(viewport: Viewport): WakeSegmentData[] {
    const segments: WakeSegmentData[] = [];
    const modifiers = this.game.entities.getTagged("waterModifier");

    const viewportRight = viewport.left + viewport.width;
    const viewportBottom = viewport.top + viewport.height;
    const expandedMinX =
      Math.min(viewport.left, viewportRight) - WAKE_VIEWPORT_MARGIN;
    const expandedMaxX =
      Math.max(viewport.left, viewportRight) + WAKE_VIEWPORT_MARGIN;
    const expandedMinY =
      Math.min(viewport.top, viewportBottom) - WAKE_VIEWPORT_MARGIN;
    const expandedMaxY =
      Math.max(viewport.top, viewportBottom) + WAKE_VIEWPORT_MARGIN;

    for (const entity of modifiers) {
      if (entity instanceof WakeParticle) {
        const aabb = entity.getWaterModifierAABB();

        if (
          aabb.maxX >= expandedMinX &&
          aabb.minX <= expandedMaxX &&
          aabb.maxY >= expandedMinY &&
          aabb.minY <= expandedMaxY
        ) {
          const segmentData = entity.getGPUSegmentData();
          if (segmentData) {
            segments.push(segmentData);
          }
        }
      }
    }

    return segments.reverse();
  }

  /**
   * Get the current tide height offset.
   * Used by GPU path to add tide to wave height.
   */
  getTideHeight(): number {
    return this.tideHeight;
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
    return this.pipeline.getTileStats();
  }

  /**
   * Reset per-frame stats counters.
   */
  resetStatsCounters(): void {
    this.pipeline.resetStats();
  }
}
