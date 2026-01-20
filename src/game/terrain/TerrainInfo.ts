/**
 * Terrain data provider with GPU acceleration.
 *
 * Provides a query interface for terrain height at any world position.
 * Supports hybrid GPU/CPU computation:
 * - GPU tiles provide terrain data for in-viewport queries (faster)
 * - CPU fallback for out-of-viewport queries (consistent)
 */

import BaseEntity from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import Game from "../../core/Game";
import { profile } from "../../core/util/Profiler";
import { V2d } from "../../core/Vector";
import { DataTileComputePipeline } from "../datatiles/DataTileComputePipeline";
import type { DataTileReadbackConfig } from "../datatiles/DataTileReadbackBuffer";
import {
  isTerrainQuerier,
  type DataTileGridConfig,
} from "../datatiles/DataTileTypes";
import { TerrainComputeCPU } from "./cpu/TerrainComputeCPU";
import { LandMass, TerrainDefinition } from "./LandMass";
import {
  MAX_TERRAIN_HEIGHT,
  TERRAIN_TILE_RESOLUTION,
  TERRAIN_TILE_SIZE,
} from "./TerrainConstants";
import { TerrainComputeBuffers } from "./webgpu/TerrainComputeBuffers";
import { TerrainDataTileCompute } from "./webgpu/TerrainDataTileCompute";

/**
 * Terrain height sample type.
 */
export interface TerrainSample {
  height: number;
}

/**
 * Terrain tile grid configuration.
 */
const TERRAIN_TILE_CONFIG: DataTileGridConfig = {
  tileSize: TERRAIN_TILE_SIZE,
  tileResolution: TERRAIN_TILE_RESOLUTION,
  maxTilesPerFrame: 64,
  minScoreThreshold: 1,
};

/**
 * Terrain readback buffer configuration.
 * Uses rgba32float format (same as water) - 4 channels, 4 bytes each = 16 bytes per pixel.
 * Height is stored directly in R channel as signed world units.
 */
const TERRAIN_READBACK_CONFIG: DataTileReadbackConfig<TerrainSample> = {
  channelCount: 4, // RGBA
  bytesPerPixel: 16, // rgba32float = 4 channels * 4 bytes
  label: "Terrain",
  texelToSample: (c) => ({ height: c[0] }), // Only use R channel
  denormalize: (s) => ({ height: s.height }), // Already in world units
};

/**
 * Terrain data provider.
 */
export class TerrainInfo extends BaseEntity {
  id = "terrainInfo";
  tickLayer = "environment" as const;

  /**
   * Get the TerrainInfo entity from a game instance.
   * Throws if not found.
   */
  static fromGame(game: Game): TerrainInfo {
    const terrainInfo = game.entities.getById("terrainInfo");
    if (!(terrainInfo instanceof TerrainInfo)) {
      throw new Error("TerrainInfo not found in game");
    }
    return terrainInfo;
  }

  /**
   * Get the TerrainInfo entity from a game instance, or undefined if not found.
   */
  static maybeFromGame(game: Game): TerrainInfo | undefined {
    const terrainInfo = game.entities.getById("terrainInfo");
    return terrainInfo instanceof TerrainInfo ? terrainInfo : undefined;
  }

  // Terrain definition (land masses)
  private terrainDefinition: TerrainDefinition;

  // Version number - increments when terrain changes
  private version: number = 0;

  // Shared GPU buffers for terrain data
  private sharedBuffers: TerrainComputeBuffers | null = null;

  // Tile pipeline for terrain queries
  private tilePipeline: DataTileComputePipeline<
    TerrainSample,
    TerrainDataTileCompute
  > | null = null;

  // CPU fallback
  private cpuFallback: TerrainComputeCPU;

  // Track initialization state
  private gpuInitialized = false;

  constructor(landMasses: LandMass[] = []) {
    super();
    this.terrainDefinition = { landMasses };
    this.cpuFallback = new TerrainComputeCPU();
  }

  @on("afterAdded")
  onAfterAdded() {
    // Initialize GPU resources after entity is fully added
    this.initGPU().catch(console.error);
  }

  /**
   * Complete tile readbacks.
   */
  @on("tick")
  @profile
  onTick() {
    // Complete readbacks from previous frame
    if (this.tilePipeline) {
      this.tilePipeline.completeReadbacks().catch((error) => {
        console.warn("Terrain tile readback error:", error);
      });
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
   */
  async initGPU(): Promise<void> {
    if (this.gpuInitialized) return;

    // Create shared buffers and upload terrain data
    this.sharedBuffers = new TerrainComputeBuffers();
    this.sharedBuffers.updateTerrainData(this.terrainDefinition);

    // Initialize tile pipeline with composition pattern
    // Pass shared buffers to factory so all tile computes share the same terrain data
    const buffers = this.sharedBuffers;
    this.tilePipeline = new DataTileComputePipeline<
      TerrainSample,
      TerrainDataTileCompute
    >(
      TERRAIN_TILE_CONFIG,
      TERRAIN_READBACK_CONFIG,
      (resolution) => new TerrainDataTileCompute(buffers, resolution),
    );
    await this.tilePipeline.init();

    this.gpuInitialized = true;
  }

  /**
   * Collect query forecasts from all terrainQuerier-tagged entities.
   */
  @profile
  private collectQueryForecasts(): void {
    if (!this.tilePipeline) return;

    this.tilePipeline.resetScores();

    for (const entity of this.game!.entities.getTagged("terrainQuerier")) {
      if (!isTerrainQuerier(entity)) {
        throw new Error(
          `Entity tagged as "terrainQuerier" does not implement TerrainQuerier interface: ${(entity as { id?: string }).id ?? entity}`,
        );
      }
      const forecast = entity.getTerrainQueryForecast();
      if (forecast) {
        this.tilePipeline.accumulateForecast(forecast);
      }
    }
  }

  /**
   * Select and compute terrain tiles for this frame.
   */
  @profile
  private computeTiles(): void {
    if (!this.tilePipeline) return;

    const currentTime = this.game!.elapsedUnpausedTime;
    const gpuProfiler = this.game?.renderer.getGpuProfiler();

    // Compute tiles using callback pattern for domain-specific compute
    this.tilePipeline.computeTiles(
      currentTime,
      (compute, viewport) => {
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
   * Get terrain height at a given world position.
   * Uses GPU tiles when available, falls back to CPU.
   *
   * @returns Height in feet above water level (0 for points in water)
   */
  getHeightAtPoint(point: V2d): number {
    // Try GPU path if initialized
    if (this.gpuInitialized && this.tilePipeline) {
      const result = this.tilePipeline.sampleAtWorldPoint(point);
      if (result) {
        return result.height;
      }
    }

    // CPU fallback
    return this.cpuFallback.computeHeightAtPoint(point, this.terrainDefinition);
  }

  /**
   * Update the terrain definition (e.g., for level loading).
   */
  setTerrainDefinition(definition: TerrainDefinition): void {
    this.terrainDefinition = definition;
    this.sharedBuffers?.updateTerrainData(definition);
    this.version++;
  }

  /**
   * Add a land mass to the terrain.
   */
  addLandMass(landMass: LandMass): void {
    this.terrainDefinition.landMasses.push(landMass);
    this.sharedBuffers?.updateTerrainData(this.terrainDefinition);
    this.version++;
  }

  /**
   * Get all land masses.
   */
  getLandMasses(): readonly LandMass[] {
    return this.terrainDefinition.landMasses;
  }

  /**
   * Get the terrain definition version.
   * Increments whenever terrain data changes.
   */
  getVersion(): number {
    return this.version;
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
    this.sharedBuffers?.destroy();
    this.sharedBuffers = null;
    this.gpuInitialized = false;
  }
}
