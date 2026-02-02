/**
 * Water physics data provider with GPU acceleration.
 *
 * Provides a query interface for water state at any world position.
 * Uses analytical wave physics with shadow-based diffraction.
 * Supports hybrid GPU/CPU computation:
 * - GPU tiles provide water data (waves + modifiers) for in-viewport queries
 * - CPU fallback for out-of-viewport queries
 */

import { createNoise3D, NoiseFunction3D } from "simplex-noise";
import { BaseEntity } from "../../../core/entity/BaseEntity";
import { on } from "../../../core/entity/handler";
import { Game } from "../../../core/Game";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import { profile } from "../../../core/util/Profiler";
import { V, V2d } from "../../../core/Vector";
import { TimeOfDay } from "../../time/TimeOfDay";
import { WavePhysicsManager } from "../../wave-physics/WavePhysicsManager";
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
import { TerrainInfo } from "../terrain/TerrainInfo";
import {
  computeWaveDataAtPoint,
  WaterComputeParams,
} from "./cpu/WaterComputeCPU";
import {
  WATER_HEIGHT_SCALE,
  WATER_VELOCITY_SCALE,
  WAVE_COMPONENTS,
} from "./WaterConstants";
import { WaterModifier } from "./WaterModifierBase";
import { isWaterQuerier } from "./WaterQuerier";
import {
  AnalyticalWaterDataTileCompute,
  type AnalyticalWaterConfig,
} from "./webgpu/AnalyticalWaterDataTileCompute";
import type { GPUWaterModifierData } from "./WaterModifierBase";

/**
 * Water point data from GPU tiles.
 */
export interface WaterPointData {
  height: number;
  dhdt: number;
  velocityX: number;
  velocityY: number;
}

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
 * Uses analytical wave physics with shadow-based diffraction.
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

  // Tile pipeline for physics queries
  private pipeline: DataTileComputePipeline<
    WaterPointData,
    AnalyticalWaterDataTileCompute
  >;

  // Wave physics manager for shadow-based diffraction
  private wavePhysicsManager: WavePhysicsManager;

  // Current simulation
  private baseCurrentVelocity: V2d = V(1.5, 0.5);
  private speedNoise: NoiseFunction3D = createNoise3D();
  private angleNoise: NoiseFunction3D = createNoise3D();

  // Wave amplitude modulation noise (for CPU fallback)
  private waveAmpModNoise: NoiseFunction3D = createNoise3D();
  private surfaceNoise: NoiseFunction3D = createNoise3D();

  // Cached modifier data for current frame
  private cachedModifiers: GPUWaterModifierData[] = [];

  // Influence field manager for depth texture
  private influenceManager: InfluenceFieldManager | null = null;

  // Terrain info for depth sampling (CPU fallback)
  private terrainInfo: TerrainInfo | null = null;

  // Track which compute instances have been configured
  private configuredComputes = new WeakSet<AnalyticalWaterDataTileCompute>();

  // Cached analytical config (set once when resources are available)
  private analyticalConfig: AnalyticalWaterConfig | null = null;

  // Current tide height offset (updated each tick from TimeOfDay)
  private tideHeight: number = 0;

  constructor() {
    super();

    // Create wave physics manager
    this.wavePhysicsManager = new WavePhysicsManager();

    // Create analytical pipeline
    const config: DataTilePipelineConfig<
      WaterPointData,
      AnalyticalWaterDataTileCompute
    > = {
      id: "waterTilePipeline",
      gridConfig: WATER_TILE_CONFIG,
      readbackConfig: WATER_READBACK_CONFIG,
      computeFactory: (resolution) =>
        new AnalyticalWaterDataTileCompute(resolution),
      getQueryForecasts: () => this.collectForecasts(),
      runCompute: (compute, viewport) => this.runTileCompute(compute, viewport),
    };
    this.pipeline = new DataTileComputePipeline(config);
  }

  @on("afterAdded")
  onAfterAdded() {
    // Add pipeline as child entity - it handles its own lifecycle
    this.addChild(this.pipeline);

    // Get reference to terrain info (for CPU depth sampling)
    this.terrainInfo = TerrainInfo.maybeFromGame(this.game) ?? null;

    // Get reference to influence field manager (needed for depth texture)
    this.influenceManager =
      InfluenceFieldManager.maybeFromGame(this.game) ?? null;

    // Initialize wave physics manager with terrain
    if (this.terrainInfo) {
      const terrainDef = this.terrainInfo.getTerrainDefinition();
      this.wavePhysicsManager.initialize(terrainDef);
    }
  }

  /**
   * Cache modifier data for current frame.
   */
  @on("tick")
  @profile
  onTick() {
    // Update tide height from TimeOfDay
    const timeOfDay = TimeOfDay.maybeFromGame(this.game);
    if (timeOfDay) {
      const hour = timeOfDay.getHour();
      // Semi-diurnal: 2 cycles per day (high at 0h & 12h, low at 6h & 18h)
      const tidePhase = (hour / 12) * Math.PI;
      this.tideHeight = Math.sin(tidePhase) * (DEFAULT_TIDE_RANGE / 2);
    }

    // Cache modifier data for this frame
    this.cachedModifiers = this.collectModifierData();
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
   * Try to build analytical config from available resources.
   * Returns null if resources aren't available yet.
   */
  private tryBuildAnalyticalConfig(): AnalyticalWaterConfig | null {
    if (!this.influenceManager) return null;

    const depthTexture = this.influenceManager.getDepthTexture();
    const depthGridConfig = this.influenceManager.getDepthGridConfig();

    if (!depthTexture || !depthGridConfig) {
      return null;
    }

    // Create a sampler for depth texture
    const device = getWebGPU().device;
    const depthSampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    return {
      depthTexture,
      depthSampler,
      depthGridConfig,
      waveSourceDirection: this.getBaseSwellDirection(),
    };
  }

  /**
   * Configure analytical compute instance if not already done.
   */
  private configureCompute(compute: AnalyticalWaterDataTileCompute): void {
    // Already configured this compute instance?
    if (this.configuredComputes.has(compute)) return;

    // Try to get/build the config
    if (!this.analyticalConfig) {
      this.analyticalConfig = this.tryBuildAnalyticalConfig();
    }

    // If we have a config and shadow resources, set them on the compute
    if (this.analyticalConfig && this.wavePhysicsManager) {
      const shadowTextureView = this.wavePhysicsManager.getShadowTextureView();

      if (shadowTextureView) {
        // Create sampler for shadow attenuation texture
        const device = getWebGPU().device;
        const shadowSampler = device.createSampler({
          magFilter: "linear",
          minFilter: "linear",
          addressModeU: "clamp-to-edge",
          addressModeV: "clamp-to-edge",
          label: "Shadow Texture Sampler",
        });

        compute.setConfig(this.analyticalConfig);
        compute.setShadowResources({ shadowTextureView, shadowSampler });
        this.configuredComputes.add(compute);
      }
    }
  }

  /**
   * Run domain-specific compute for a tile.
   */
  private runTileCompute(
    compute: AnalyticalWaterDataTileCompute,
    viewport: ReadbackViewport,
  ): void {
    // Ensure compute is configured with depth and shadow buffers
    this.configureCompute(compute);

    // Set water modifiers for modifier computation
    compute.setModifiers(this.cachedModifiers);

    // Set tide height for this compute pass
    compute.setTideHeight(this.tideHeight);

    // Run the compute
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

    // Build CPU params for query point
    const cpuParams = this.buildCPUParamsForPoint(point);

    // CPU fallback: waves + modifier queries
    const waveData = computeWaveDataAtPoint(point[0], point[1], cpuParams);

    // Add tide height to surface height
    // Note: CPU fallback no longer includes water modifiers (wake, ripples).
    // Modifiers are GPU-only now. Queries outside data tiles will only get base wave physics.
    const surfaceHeight = waveData.height + this.tideHeight;
    const surfaceHeightRate = waveData.dhdt;

    return {
      velocity,
      surfaceHeight,
      surfaceHeightRate,
    };
  }

  /**
   * Build CPU compute params for a specific query point.
   */
  private buildCPUParamsForPoint(point: V2d): WaterComputeParams {
    const time = this.getGameTime();

    // Default values (no terrain influence - use full wave amplitude)
    const swellEnergyFactor = 1.0;
    const chopEnergyFactor = 1.0;
    const fetchFactor = 1.0;
    const swellDirectionOffset = 0;
    const chopDirectionOffset = 0;

    // Sample terrain depth at query point (positive = land, negative = underwater)
    // Default to deep water (-100) if terrain info is not available
    const depth = this.terrainInfo
      ? this.terrainInfo.getHeightAtPoint(point)
      : -100;

    return {
      time,
      waveAmpModNoise: this.waveAmpModNoise,
      surfaceNoise: this.surfaceNoise,
      swellEnergyFactor,
      chopEnergyFactor,
      fetchFactor,
      swellDirectionOffset,
      chopDirectionOffset,
      depth,
    };
  }

  /**
   * Collect water modifier data for GPU compute shader.
   * Gathers all active modifiers (wakes, ripples, etc.) from waterModifier-tagged entities.
   */
  private collectModifierData(): GPUWaterModifierData[] {
    const modifiers: GPUWaterModifierData[] = [];

    for (const entity of this.game.entities.getTagged("waterModifier")) {
      if (entity instanceof WaterModifier) {
        const data = entity.getGPUModifierData();
        if (data !== null) {
          modifiers.push(data);
        }
      }
    }

    return modifiers;
  }

  /**
   * Get the current tide height offset.
   * Used by GPU path to add tide to wave height.
   */
  getTideHeight(): number {
    return this.tideHeight;
  }

  /**
   * Get the WavePhysicsManager for shadow-based diffraction.
   */
  getWavePhysicsManager(): WavePhysicsManager {
    return this.wavePhysicsManager;
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
