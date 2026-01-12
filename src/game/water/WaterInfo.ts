import { createNoise3D, NoiseFunction3D } from "simplex-noise";
import BaseEntity from "../../core/entity/BaseEntity";
import Game from "../../core/Game";
import { profile } from "../../core/util/Profiler";
import { SparseSpatialHash } from "../../core/util/SparseSpatialHash";
import type {
  StatsProvider,
  StatsSection,
} from "../../core/util/stats-overlay/StatsProvider";
import { V, V2d } from "../../core/Vector";
import {
  computeWaveDataAtPoint,
  WaterComputeParams,
} from "./cpu/WaterComputeCPU";
import type { TileManager } from "./tiles/TileManager";
import type { TileReadbackPool } from "./tiles/TileReadbackPool";
import { WakeParticle } from "./WakeParticle";
import { WaterModifier } from "./WaterModifier";
import { isWaterQuerier } from "./WaterQuerier";
import type { WakeSegmentData } from "./webgpu/ModifierComputeGPU";
import type { WaterReadbackBuffer } from "./webgpu/WaterReadbackBuffer";
import type { Viewport } from "./webgpu/WaterComputePipelineGPU";

// Units: ft, ft/s for velocities
// Current variation configuration
// Water currents are much slower and vary more gradually than wind
const CURRENT_SPATIAL_SCALE = 0.002; // Currents vary slowly across space
const CURRENT_TIME_SCALE = 0.05; // Currents change slowly over time
const CURRENT_SPEED_VARIATION = 0.4; // ±40% speed variation
const CURRENT_ANGLE_VARIATION = 0.5; // ±~30° direction variation

// Minimum resolution (pixels per foot) for GPU wave data to be considered adequate
// for physics calculations. Below this threshold, fall back to CPU computation.
// Based on Nyquist: shortest waves are ~2ft ripples, need 2 samples per wavelength,
// so minimum ~1 px/ft, using 2 px/ft for safety margin.
const MIN_PHYSICS_RESOLUTION = 2;

// Margin to expand viewport for wake particle filtering (ft)
// Must be >= MAX_RADIUS from WakeParticle.ts to catch particles that affect the edge
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
 * Water physics data provider.
 * Provides a query interface for water state at any world position,
 * used by underwater physics components (keel, rudder, hull).
 *
 * Supports hybrid GPU/CPU wave computation:
 * - GPU readback provides wave data for in-viewport queries (faster)
 * - CPU fallback for out-of-viewport queries (consistent)
 */
export class WaterInfo extends BaseEntity implements StatsProvider {
  id = "waterInfo";
  tags = ["statsProvider"];

  /**
   * Get the WaterInfo entity from a game instance.
   * @throws Error if WaterInfo is not found in the game
   */
  static fromGame(game: Game): WaterInfo {
    const waterInfo = game.entities.getById("waterInfo");
    if (!(waterInfo instanceof WaterInfo)) {
      throw new Error("WaterInfo not found in game");
    }
    return waterInfo;
  }

  // Current simulation
  private baseCurrentVelocity: V2d = V(1.5, 0.5); // ~1.6 ft/s (~1 kt) tidal current
  private speedNoise: NoiseFunction3D = createNoise3D();
  private angleNoise: NoiseFunction3D = createNoise3D();

  // Wave amplitude modulation - simulates wave groups/packets (physically real)
  private waveAmpModNoise: NoiseFunction3D = createNoise3D();

  // Surface turbulence noise - small chaotic variations that break up the grid
  private surfaceNoise: NoiseFunction3D = createNoise3D();

  // Spatial hash for efficient water modifier queries
  private spatialHash = new SparseSpatialHash<WaterModifier>((m) =>
    m.getWaterModifierAABB(),
  );

  // GPU readback buffer for physics queries (set by WaterRendererGPU)
  private readbackBuffer: WaterReadbackBuffer | null = null;

  // Tile system for physics queries (set by WaterRendererGPU)
  private tileManager: TileManager | null = null;
  private tileReadbackPool: TileReadbackPool | null = null;

  // CPU compute params (cached for fallback computations)
  private get cpuParams(): WaterComputeParams {
    return {
      time:
        this.readbackBuffer?.getComputedTime() ??
        this.game?.elapsedUnpausedTime ??
        0,
      waveAmpModNoise: this.waveAmpModNoise,
      surfaceNoise: this.surfaceNoise,
    };
  }

  @profile
  onTick() {
    // Rebuild spatial hash from all water modifiers
    this.spatialHash.clear();
    const modifiers = this.game!.entities.getTagged("waterModifier");
    for (const modifier of modifiers) {
      this.spatialHash.add(modifier as unknown as WaterModifier);
    }
  }

  /**
   * Set the GPU readback buffer for physics queries.
   * Called by WaterRendererGPU after initialization.
   */
  setReadbackBuffer(buffer: WaterReadbackBuffer): void {
    this.readbackBuffer = buffer;
  }

  /**
   * Set the tile system for physics queries.
   * Called by WaterRendererGPU after initialization.
   */
  setTileSystem(
    tileManager: TileManager,
    tileReadbackPool: TileReadbackPool,
  ): void {
    this.tileManager = tileManager;
    this.tileReadbackPool = tileReadbackPool;
  }

  /**
   * Collect query forecasts from all WaterQuerier entities.
   * Called during tile selection phase (before GPU compute).
   */
  collectQueryForecasts(): void {
    if (!this.tileManager) return;

    this.tileManager.resetScores();

    // Find all entities that implement WaterQuerier
    const queriers = this.game!.entities.getTagged("waterQuerier");
    for (const entity of queriers) {
      if (isWaterQuerier(entity)) {
        const forecast = entity.getQueryForecast();
        if (forecast) {
          this.tileManager.accumulateScore(forecast);
        }
      }
    }
  }

  /**
   * Get readback statistics for debugging/tuning.
   * Returns null if no readback buffer is set.
   */
  getReadbackStats(): {
    gpuHits: number;
    cpuFallbacks: number;
    lowResolutionFallbacks: number;
    outOfBoundsFallbacks: number;
    currentResolution: number;
  } | null {
    return this.readbackBuffer?.stats ?? null;
  }

  /**
   * StatsProvider implementation - provides water readback stats for StatsOverlay
   */
  getStatsSection(): StatsSection | null {
    const stats = this.readbackBuffer?.stats;
    if (!stats) return null;

    const total = stats.gpuHits + stats.cpuFallbacks;
    if (total === 0) return null;

    const gpuPercent = (stats.gpuHits / total) * 100;
    const items: StatsSection["items"] = [
      {
        label: "Water Res",
        value: `${stats.currentResolution.toFixed(1)} px/ft`,
        color:
          stats.currentResolution >= 2
            ? "success"
            : stats.currentResolution >= 1
              ? "warning"
              : "error",
      },
      {
        label: "Water GPU Hits",
        value: `${gpuPercent.toFixed(0)}% (${stats.gpuHits}/${total})`,
        color:
          gpuPercent > 90 ? "success" : gpuPercent > 50 ? "warning" : "error",
      },
    ];

    // Add tile stats if tile system is active
    if (this.tileManager && this.tileReadbackPool) {
      const activeTiles = this.tileManager.getActiveTileCount();
      const tileHits = this.tileReadbackPool.stats.tileHits;
      items.push({
        label: "Active Tiles",
        value: `${activeTiles}`,
        color: activeTiles > 0 ? "success" : "muted",
      });
      if (tileHits > 0) {
        items.push({
          label: "Tile Hits",
          value: `${tileHits}`,
          indent: true,
          color: "success",
        });
      }
    }

    // Add fallback breakdown if any
    if (stats.lowResolutionFallbacks > 0 || stats.outOfBoundsFallbacks > 0) {
      const parts: string[] = [];
      if (stats.lowResolutionFallbacks > 0) {
        parts.push(`${stats.lowResolutionFallbacks} low-res`);
      }
      if (stats.outOfBoundsFallbacks > 0) {
        parts.push(`${stats.outOfBoundsFallbacks} OOB`);
      }
      items.push({
        label: "Fallbacks",
        value: parts.join(" / "),
        indent: true,
        color: "muted",
      });
    }

    return {
      title: "Water Readback",
      items,
    };
  }

  /**
   * StatsProvider implementation - reset per-frame counters
   */
  resetStatsCounters(): void {
    if (this.readbackBuffer?.stats) {
      const stats = this.readbackBuffer.stats;
      stats.gpuHits = 0;
      stats.cpuFallbacks = 0;
      stats.lowResolutionFallbacks = 0;
      stats.outOfBoundsFallbacks = 0;
    }
    // Reset tile stats
    if (this.tileReadbackPool?.stats) {
      this.tileReadbackPool.stats.reset();
    }
  }

  /**
   * Get the water state at a given world position.
   * Checks tile readback buffers first, then camera viewport buffer,
   * otherwise falls back to CPU computation.
   * Used by underwater physics components to determine water velocity.
   */
  getStateAtPoint(point: V2d): WaterState {
    // Start with current velocity
    const velocity = this.getCurrentVelocityAtPoint(point);

    // Try tile-based lookup first
    let waveData = null;
    if (this.tileManager && this.tileReadbackPool) {
      const tile = this.tileManager.findTileForPoint(point[0], point[1]);
      if (tile) {
        waveData = this.tileReadbackPool.sampleAtWorldPoint(
          tile,
          point[0],
          point[1],
        );
        // Track tile hit in readback stats
        if (waveData && this.readbackBuffer?.stats) {
          this.readbackBuffer.stats.gpuHits++;
        }
      }
    }

    // Fall back to camera viewport readback if tile lookup failed
    if (!waveData && this.readbackBuffer) {
      const hasAdequate = this.readbackBuffer.hasAdequateResolution(
        point[0],
        point[1],
        MIN_PHYSICS_RESOLUTION,
      );

      if (hasAdequate) {
        // Resolution is adequate, sample from GPU buffer
        waveData = this.readbackBuffer.sampleAt(point[0], point[1]);
      } else {
        // Track why we're falling back
        const stats = this.readbackBuffer.stats;
        stats.cpuFallbacks++;

        if (!this.readbackBuffer.isInViewport(point[0], point[1])) {
          stats.outOfBoundsFallbacks++;
        } else {
          stats.lowResolutionFallbacks++;
        }
      }
    }

    if (!waveData) {
      // CPU fallback - use the same time as GPU computation for consistency
      waveData = computeWaveDataAtPoint(point[0], point[1], this.cpuParams);
    }

    let surfaceHeight = waveData.height;
    let surfaceHeightRate = waveData.dhdt;

    // Query spatial hash for nearby water modifiers
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
   * Get the current velocity at a given world position.
   * Uses simplex noise for natural spatial and temporal variation.
   */
  private getCurrentVelocityAtPoint([x, y]: V2d): V2d {
    const t = (this.game?.elapsedUnpausedTime ?? 0) * CURRENT_TIME_SCALE;

    const sx = x * CURRENT_SPATIAL_SCALE;
    const sy = y * CURRENT_SPATIAL_SCALE;

    // Sample noise for speed and angle variation
    const speedScale = 1 + this.speedNoise(sx, sy, t) * CURRENT_SPEED_VARIATION;
    const angleVariance = this.angleNoise(sx, sy, t) * CURRENT_ANGLE_VARIATION;

    return this.baseCurrentVelocity.mul(speedScale).irotate(angleVariance);
  }

  /**
   * Set the base current velocity.
   */
  setCurrentVelocity(velocity: V2d): void {
    this.baseCurrentVelocity.set(velocity);
  }

  /**
   * Get the current speed (magnitude of base velocity).
   */
  getCurrentSpeed(): number {
    return this.baseCurrentVelocity.magnitude;
  }

  /**
   * Get the current direction angle.
   */
  getCurrentAngle(): number {
    return this.baseCurrentVelocity.angle;
  }

  /**
   * Query water modifiers at a given point.
   * Used by ModifierDataTexture to build the modifier texture.
   */
  queryModifiersAtPoint(point: V2d): Iterable<WaterModifier> {
    return this.spatialHash.queryPoint(point);
  }

  /**
   * Get all water modifiers.
   * Used by ModifierDataTexture to iterate through modifiers efficiently.
   */
  getAllModifiers(): Iterable<WaterModifier> {
    const modifiers = this.game!.entities.getTagged("waterModifier");
    // Debug: uncomment to verify modifiers are found
    // console.log("[WaterInfo] getAllModifiers:", modifiers.length);
    return modifiers as unknown as WaterModifier[];
  }

  /**
   * Collect wake segment data for GPU compute shader.
   * Returns an array of segment data that can be uploaded to GPU buffer.
   * Filters to only include particles that intersect the expanded viewport.
   * Reversed so newest particles are first (prioritized when hitting segment limit).
   */
  collectGPUSegmentData(viewport: Viewport): WakeSegmentData[] {
    const segments: WakeSegmentData[] = [];
    const modifiers = this.game!.entities.getTagged("waterModifier");

    // Expand viewport by margin to catch particles that affect the edges
    // Note: viewport.height can be negative (Y-up coordinate system), so use min/max
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

        // Check if particle's AABB intersects expanded viewport
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

    // Reverse so newest particles are first - when we hit MAX_SEGMENTS limit,
    // we want to keep the newest (near the boat) and drop the oldest (far behind)
    return segments.reverse();
  }
}
