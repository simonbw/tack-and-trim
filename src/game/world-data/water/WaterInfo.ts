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
import {
  computeWaveDataAtPoint,
  WaterComputeParams,
} from "./cpu/WaterComputeCPU";
import { WakeParticle } from "./WakeParticle";
import { WATER_HEIGHT_SCALE, WATER_VELOCITY_SCALE } from "./WaterConstants";
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

  // CPU compute params (cached for fallback computations)
  private get cpuParams(): WaterComputeParams {
    return {
      time: this.game?.elapsedUnpausedTime ?? 0,
      waveAmpModNoise: this.waveAmpModNoise,
      surfaceNoise: this.surfaceNoise,
    };
  }

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
  }

  /**
   * Rebuild spatial hash for CPU fallback and cache segment data.
   */
  @on("tick")
  @profile
  onTick() {
    // Rebuild spatial hash for CPU fallback
    this.spatialHash.clear();
    for (const entity of this.game!.entities.getTagged("waterModifier")) {
      if (isWaterModifier(entity)) {
        this.spatialHash.add(entity);
      }
    }

    // Cache segment data for this frame
    const camera = this.game!.camera;
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
    for (const entity of this.game!.entities.getTagged("waterQuerier")) {
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
   * Run domain-specific compute for a tile.
   */
  private runTileCompute(
    compute: WaterDataTileCompute,
    viewport: ReadbackViewport,
  ): void {
    compute.setSegments(this.cachedSegments);
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
