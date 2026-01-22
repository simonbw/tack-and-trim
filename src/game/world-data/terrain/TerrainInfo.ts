/**
 * Terrain data provider with GPU acceleration.
 *
 * Provides a query interface for terrain height at any world position.
 * Supports hybrid GPU/CPU computation:
 * - GPU tiles provide terrain data for in-viewport queries (faster)
 * - CPU fallback for out-of-viewport queries (consistent)
 */

import { BaseEntity } from "../../../core/entity/BaseEntity";
import { on } from "../../../core/entity/handler";
import { Game } from "../../../core/Game";
import { V2d } from "../../../core/Vector";
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
import { TerrainComputeCPU } from "./cpu/TerrainComputeCPU";
import { LandMass, TerrainDefinition } from "./LandMass";
import { TERRAIN_TILE_RESOLUTION, TERRAIN_TILE_SIZE } from "./TerrainConstants";
import { isTerrainQuerier } from "./TerrainQuerier";
import { TerrainComputeBuffers } from "./webgpu/TerrainComputeBuffers";
import { TerrainDataTileCompute } from "./webgpu/TerrainDataTileCompute";

/**
 * Terrain height sample type.
 */
export interface TerrainPointData {
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
const TERRAIN_READBACK_CONFIG: DataTileReadbackConfig<TerrainPointData> = {
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

  // Track which tiles have been computed for current terrain version
  private computedTileVersions = new Map<string, number>();

  // Shared GPU buffers for terrain data
  private sharedBuffers: TerrainComputeBuffers | null = null;

  // Tile pipeline for terrain queries (created in constructor)
  private pipeline: DataTileComputePipeline<
    TerrainPointData,
    TerrainDataTileCompute
  >;

  // CPU fallback
  private cpuFallback: TerrainComputeCPU;

  constructor(landMasses: LandMass[] = []) {
    super();
    this.terrainDefinition = { landMasses };
    this.cpuFallback = new TerrainComputeCPU();

    // Create shared buffers (will be initialized with terrain data in onAfterAdded)
    this.sharedBuffers = new TerrainComputeBuffers();

    // Create pipeline with config - pipeline handles its own lifecycle
    const buffers = this.sharedBuffers;
    const config: DataTilePipelineConfig<
      TerrainPointData,
      TerrainDataTileCompute
    > = {
      id: "terrainTilePipeline",
      gridConfig: TERRAIN_TILE_CONFIG,
      readbackConfig: TERRAIN_READBACK_CONFIG,
      computeFactory: (resolution) =>
        new TerrainDataTileCompute(buffers, resolution),
      getQueryForecasts: () => this.collectForecasts(),
      runCompute: (compute, viewport) => this.runTileCompute(compute, viewport),
      shouldCompute: (tile) => {
        // Skip if already computed for current terrain version
        return this.computedTileVersions.get(tile.id) !== this.version;
      },
      onComputed: (tile) => {
        // Mark this tile as computed for current version
        this.computedTileVersions.set(tile.id, this.version);
      },
    };
    this.pipeline = new DataTileComputePipeline(config);
  }

  @on("afterAdded")
  onAfterAdded() {
    // Initialize shared buffers with terrain data
    this.sharedBuffers?.updateTerrainData(this.terrainDefinition);

    // Add pipeline as child entity - it handles its own lifecycle
    this.addChild(this.pipeline);
  }

  /**
   * Collect query forecasts from all terrainQuerier-tagged entities.
   */
  private *collectForecasts(): Iterable<QueryForecast> {
    for (const entity of this.game.entities.getTagged("terrainQuerier")) {
      if (!isTerrainQuerier(entity)) {
        throw new Error(
          `Entity tagged as "terrainQuerier" does not implement TerrainQuerier interface: ${(entity as { id?: string }).id ?? entity}`,
        );
      }
      const forecast = entity.getTerrainQueryForecast();
      if (forecast) {
        yield forecast;
      }
    }
  }

  /**
   * Run domain-specific compute for a tile.
   */
  private runTileCompute(
    compute: TerrainDataTileCompute,
    viewport: ReadbackViewport,
  ): void {
    compute.runCompute(
      viewport.time,
      viewport.left,
      viewport.top,
      viewport.width,
      viewport.height,
    );
  }

  /**
   * Get terrain height at a given world position.
   * Uses GPU tiles when available, falls back to CPU.
   *
   * @returns Height in feet above water level (0 for points in water)
   */
  getHeightAtPoint(point: V2d): number {
    // Try GPU path
    const result = this.pipeline.sampleAtWorldPoint(point);
    if (result) {
      return result.height;
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
    this.computedTileVersions.clear(); // Invalidate all cached tiles
  }

  /**
   * Add a land mass to the terrain.
   */
  addLandMass(landMass: LandMass): void {
    this.terrainDefinition.landMasses.push(landMass);
    this.sharedBuffers?.updateTerrainData(this.terrainDefinition);
    this.version++;
    this.computedTileVersions.clear(); // Invalidate all cached tiles
  }

  /**
   * Get all land masses.
   */
  getLandMasses(): readonly LandMass[] {
    return this.terrainDefinition.landMasses;
  }

  /**
   * Get signed distance from a point to the nearest coastline.
   * Positive = in water, Negative = on land.
   */
  getShoreDistance(point: V2d): number {
    let minSignedDist = Infinity;
    for (const landMass of this.terrainDefinition.landMasses) {
      const signedDist = this.cpuFallback.computeSignedDistance(
        point,
        landMass,
      );
      minSignedDist = Math.min(minSignedDist, signedDist);
    }
    return minSignedDist === Infinity ? 10000 : minSignedDist;
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

  /**
   * Clean up GPU resources.
   */
  @on("destroy")
  onDestroy() {
    this.sharedBuffers?.destroy();
    this.sharedBuffers = null;
  }
}
