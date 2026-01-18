/**
 * Water physics data provider with GPU acceleration.
 *
 * Provides a query interface for water state at any world position.
 * Supports hybrid GPU/CPU computation:
 * - GPU tiles provide water data (waves + modifiers) for in-viewport queries
 * - CPU fallback for out-of-viewport queries
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
import {
  isWaterQuerier,
  type DataTileGridConfig,
} from "../datatiles/DataTileTypes";
import {
  computeWaveDataAtPoint,
  WaterComputeParams,
} from "./cpu/WaterComputeCPU";
import { WakeParticle } from "./WakeParticle";
import { isWaterModifier, WaterModifier } from "./WaterModifier";
import type { WakeSegmentData } from "./webgpu/WaterComputeBuffers";
import {
  WaterDataTileCompute,
  type WaterPhysicsData,
} from "./webgpu/WaterDataTileCompute";

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
const WATER_READBACK_CONFIG: DataTileReadbackConfig<WaterPhysicsData> = {
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
    height: (s.height - 0.5) * 5.0,
    dhdt: (s.dhdt - 0.5) * 10.0,
    velocityX: (s.velocityX - 0.5) * 10.0,
    velocityY: (s.velocityY - 0.5) * 10.0,
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

  // Tile pipeline for physics queries (owned by WaterInfo)
  private tilePipeline: DataTileComputePipeline<
    WaterPhysicsData,
    WaterDataTileCompute
  > | null = null;
  private gpuInitialized = false;

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

  // CPU compute params (cached for fallback computations)
  private get cpuParams(): WaterComputeParams {
    return {
      time: this.game?.elapsedUnpausedTime ?? 0,
      waveAmpModNoise: this.waveAmpModNoise,
      surfaceNoise: this.surfaceNoise,
    };
  }

  @on("afterAdded")
  onAfterAdded() {
    this.initGPU().catch(console.error);
  }

  /**
   * Initialize GPU resources.
   */
  async initGPU(): Promise<void> {
    if (this.gpuInitialized) return;

    this.tilePipeline = new DataTileComputePipeline<
      WaterPhysicsData,
      WaterDataTileCompute
    >(
      WATER_TILE_CONFIG,
      WATER_READBACK_CONFIG,
      (resolution) => new WaterDataTileCompute(resolution),
    );
    await this.tilePipeline.init();

    this.gpuInitialized = true;
  }

  /**
   * Complete pending readbacks from previous frame.
   * Called at start of tick.
   */
  @on("tick")
  @profile
  onTick() {
    // Complete readbacks from previous frame
    if (this.tilePipeline) {
      this.tilePipeline.completeReadbacks().catch((error) => {
        console.warn("Water tile readback error:", error);
      });
    }

    // Rebuild spatial hash for CPU fallback
    this.spatialHash.clear();
    for (const entity of this.game!.entities.getTagged("waterModifier")) {
      if (isWaterModifier(entity)) {
        this.spatialHash.add(entity);
      }
    }
  }

  /**
   * Compute tiles after physics.
   * Called via afterPhysics event.
   */
  @on("afterPhysics")
  @profile
  onAfterPhysics() {
    if (!this.tilePipeline || !this.gpuInitialized) return;

    this.collectQueryForecasts();
    this.computeTiles();
  }

  /**
   * Collect query forecasts from all waterQuerier-tagged entities.
   */
  @profile
  private collectQueryForecasts(): void {
    if (!this.tilePipeline) return;

    this.tilePipeline.resetScores();

    for (const entity of this.game!.entities.getTagged("waterQuerier")) {
      if (isWaterQuerier(entity)) {
        const forecast = entity.getWaterQueryForecast();
        if (forecast) {
          this.tilePipeline.accumulateForecast(forecast);
        }
      }
    }
  }

  /**
   * Compute tiles for this frame.
   */
  @profile
  private computeTiles(): void {
    if (!this.tilePipeline) return;

    const time = this.game!.elapsedUnpausedTime;
    const gpuProfiler = this.game?.renderer.getGpuProfiler();

    // Collect segment data for all tiles (using full world bounds approximation)
    // Each tile will receive the same segment data
    const camera = this.game!.camera;
    const worldViewport = camera.getWorldViewport();
    this.cachedSegments = this.collectShaderSegmentData({
      left: worldViewport.left - WAKE_VIEWPORT_MARGIN * 2,
      top: worldViewport.top - WAKE_VIEWPORT_MARGIN * 2,
      width: worldViewport.width + WAKE_VIEWPORT_MARGIN * 4,
      height: worldViewport.height + WAKE_VIEWPORT_MARGIN * 4,
    });

    // Compute tiles with segment data
    this.tilePipeline.computeTiles(
      time,
      (compute, viewport) => {
        compute.setSegments(this.cachedSegments);
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
   * Get water state at a given world position.
   * Uses GPU tiles when available, falls back to CPU.
   */
  getStateAtPoint(point: V2d): WaterState {
    return this.getStateAtPointGPU(point) ?? this.getStateAtPointCPU(point);
  }

  private getStateAtPointGPU(point: V2d): WaterState | null {
    if (!this.tilePipeline) return null;

    const physicsData = this.tilePipeline.sampleAtWorldPoint(
      point[0],
      point[1],
    );
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
    const t = (this.game?.elapsedUnpausedTime ?? 0) * CURRENT_TIME_SCALE;

    const sx = point.x * CURRENT_SPATIAL_SCALE;
    const sy = point.y * CURRENT_SPATIAL_SCALE;

    const speedScale = 1 + this.speedNoise(sx, sy, t) * CURRENT_SPEED_VARIATION;
    const angleVariance = this.angleNoise(sx, sy, t) * CURRENT_ANGLE_VARIATION;

    const velocity = this.baseCurrentVelocity
      .mul(speedScale)
      .irotate(angleVariance);

    // CPU fallback: waves + modifier queries
    const waveData = computeWaveDataAtPoint(point[0], point[1], this.cpuParams);

    let surfaceHeight = waveData.height;
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
   * Collect wake segment data for GPU compute shader.
   * Filters to particles that intersect the viewport.
   */
  collectShaderSegmentData(viewport: Viewport): WakeSegmentData[] {
    const segments: WakeSegmentData[] = [];
    const modifiers = this.game!.entities.getTagged("waterModifier");

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
   * Clean up GPU resources.
   */
  @on("destroy")
  onDestroy() {
    this.tilePipeline?.destroy();
    this.tilePipeline = null;
    this.gpuInitialized = false;
  }
}
