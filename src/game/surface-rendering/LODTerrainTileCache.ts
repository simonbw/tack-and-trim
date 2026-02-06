/**
 * LOD Terrain Tile Cache
 *
 * Manages multiple TerrainTileCache instances at different LOD levels to support
 * extreme zoom ranges (0.02 to 1.0+). Each LOD covers progressively larger world
 * areas per tile, allowing the editor to zoom out to MIN_ZOOM = 0.02 which shows
 * ~96,000 world units.
 *
 * LOD selection is based on camera zoom with hysteresis to prevent flickering
 * during smooth zoom transitions.
 *
 * | LOD | World Units/Tile | Tiles | Coverage | Min Zoom |
 * |-----|------------------|-------|----------|----------|
 * | 0   | 64               | 512   | ~1,500   | 1.0      |
 * | 1   | 256              | 256   | ~6,000   | 0.25     |
 * | 2   | 1024             | 128   | ~24,000  | 0.06     |
 * | 3   | 4096             | 64    | ~94,000  | 0.02     |
 */

import type { GPUProfiler } from "../../core/graphics/webgpu/GPUProfiler";
import type { Viewport } from "../wave-physics/WavePhysicsResources";
import type { TerrainResources } from "../world/terrain/TerrainResources";
import { TerrainTileCache, type VisibleTile } from "./TerrainTileCache";
import type { TileRequest } from "../../core/graphics/VirtualTextureCache";

/**
 * Configuration for a single LOD level.
 */
export interface LODConfig {
  /** World units covered by each tile at this LOD */
  worldUnitsPerTile: number;
  /** Maximum number of tiles to cache at this LOD */
  maxTiles: number;
  /** Minimum camera zoom where this LOD is used */
  minZoom: number;
}

/**
 * Configuration for the LOD terrain tile cache.
 */
export interface LODTerrainTileCacheConfig {
  /** Configuration for each LOD level, ordered from highest detail (LOD 0) to lowest */
  lodConfigs: LODConfig[];
  /** Hysteresis factor for LOD transitions (default: 0.2 = 20%) */
  hysteresis?: number;
}

/**
 * Default LOD configuration covering zoom range 0.02 to 50+.
 *
 * Visible tiles ≈ (screenWidth / zoom) / worldUnitsPerTile
 * Since worldUnitsPerTile scales 4x per LOD, minZoom scales 1/4x to keep
 * visible tile count roughly constant (~10-15 tiles per axis).
 *
 * All LODs use 256 tiles (16x16) except the most zoomed out which needs
 * 1024 (32x32) to handle extreme zoom where viewport spans ~24 tiles per axis.
 */
const DEFAULT_LOD_CONFIGS: LODConfig[] = [
  { worldUnitsPerTile: 16, maxTiles: 256, minZoom: 12.0 },
  { worldUnitsPerTile: 64, maxTiles: 256, minZoom: 3.0 },
  { worldUnitsPerTile: 256, maxTiles: 256, minZoom: 0.75 },
  { worldUnitsPerTile: 1024, maxTiles: 256, minZoom: 0.19 },
  { worldUnitsPerTile: 4096, maxTiles: 1024, minZoom: 0.0 },
];

/**
 * LOD manager for terrain tile caching.
 *
 * Creates multiple TerrainTileCache instances with different worldUnitsPerTile
 * values and selects the appropriate one based on camera zoom.
 */
export class LODTerrainTileCache {
  private readonly lodConfigs: LODConfig[];
  private readonly caches: TerrainTileCache[];
  private readonly hysteresis: number;

  private currentLOD = 0;
  private initialized = false;

  constructor(
    config: LODTerrainTileCacheConfig = { lodConfigs: DEFAULT_LOD_CONFIGS },
  ) {
    this.lodConfigs = config.lodConfigs;
    this.hysteresis = config.hysteresis ?? 0.05;

    // Create a TerrainTileCache for each LOD level
    this.caches = this.lodConfigs.map(
      (lodConfig) =>
        new TerrainTileCache({
          worldUnitsPerTile: lodConfig.worldUnitsPerTile,
          maxTiles: lodConfig.maxTiles,
        }),
    );
  }

  /**
   * Initialize all LOD caches.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    await Promise.all(this.caches.map((cache) => cache.init()));
    this.initialized = true;
  }

  /**
   * Select the appropriate LOD level based on camera zoom.
   *
   * Uses hysteresis to prevent flickering when zooming near LOD boundaries.
   * The current LOD is "sticky" - we only switch when the zoom moves
   * significantly past the threshold.
   *
   * @param zoom - Current camera zoom level (higher = more zoomed in)
   * @returns The selected LOD index
   */
  selectLOD(zoom: number): number {
    // Find the ideal LOD for this zoom level
    // LODs are ordered from highest detail (LOD 0) to lowest detail
    let idealLOD = this.lodConfigs.length - 1; // Default to lowest detail
    for (let i = 0; i < this.lodConfigs.length; i++) {
      if (zoom >= this.lodConfigs[i].minZoom) {
        idealLOD = i;
        break;
      }
    }

    // Apply hysteresis: only switch LOD if zoom has moved significantly
    // past the threshold (20% beyond the boundary)
    if (idealLOD !== this.currentLOD) {
      const currentConfig = this.lodConfigs[this.currentLOD];

      if (idealLOD < this.currentLOD) {
        // Trying to switch to higher detail (zooming in)
        // Only switch if zoom is well above the current LOD's threshold
        const threshold = currentConfig.minZoom * (1 + this.hysteresis);
        if (zoom >= threshold) {
          this.currentLOD = idealLOD;
        }
      } else {
        // Trying to switch to lower detail (zooming out)
        // Only switch if zoom is well below the current LOD's threshold
        // (using current, not ideal, because ideal's minZoom could be 0)
        const threshold = currentConfig.minZoom * (1 - this.hysteresis);
        if (zoom <= threshold) {
          this.currentLOD = idealLOD;
        }
      }
    }

    return this.currentLOD;
  }

  /**
   * Check if terrain has changed and invalidate all LOD caches if needed.
   *
   * @returns true if caches were invalidated
   */
  checkInvalidation(terrainResources: TerrainResources): boolean {
    // Only need to check one cache since they all share the same terrain version
    // But we need to invalidate all of them if terrain changed
    let invalidated = false;
    for (const cache of this.caches) {
      if (cache.checkInvalidation(terrainResources)) {
        invalidated = true;
      }
    }
    return invalidated;
  }

  /**
   * Update the cache for the current viewport and zoom level.
   * Returns tile requests that need rendering.
   *
   * @param viewport - The expanded viewport to cache tiles for
   * @param zoom - Current camera zoom level for LOD selection
   * @param terrainResources - Terrain data resources
   */
  update(
    viewport: Viewport,
    zoom: number,
    terrainResources: TerrainResources,
  ): TileRequest[] {
    if (!this.initialized) return [];

    // Select LOD based on zoom
    this.selectLOD(zoom);

    // Update only the current LOD's cache
    return this.caches[this.currentLOD].update(viewport, terrainResources);
  }

  /**
   * Render missing tiles to the current LOD's atlas.
   */
  renderTiles(
    requests: TileRequest[],
    terrainResources: TerrainResources,
    gpuProfiler?: GPUProfiler,
  ): void {
    if (!this.initialized || requests.length === 0) return;
    this.caches[this.currentLOD].renderTiles(
      requests,
      terrainResources,
      gpuProfiler,
    );
  }

  /**
   * Get the current LOD's atlas texture view for sampling.
   */
  getAtlasView(): GPUTextureView {
    return this.caches[this.currentLOD].getAtlasView();
  }

  /**
   * Get the current LOD's atlas texture.
   */
  getAtlasTexture(): GPUTexture {
    return this.caches[this.currentLOD].getAtlasTexture();
  }

  /**
   * Get the current LOD's atlas info for shader uniforms.
   */
  getAtlasInfo(): {
    atlasWidth: number;
    atlasHeight: number;
    tileSize: number;
    tilesX: number;
    tilesY: number;
    worldUnitsPerTile: number;
  } {
    return this.caches[this.currentLOD].getAtlasInfo();
  }

  /**
   * Get list of currently visible tiles that are ready for rendering.
   */
  getVisibleTiles(): readonly VisibleTile[] {
    return this.caches[this.currentLOD].getVisibleTiles();
  }

  /**
   * Get the current LOD level (0 = highest detail).
   */
  getCurrentLOD(): number {
    return this.currentLOD;
  }

  /**
   * Get the current LOD's configuration.
   */
  getCurrentLODConfig(): LODConfig {
    return this.lodConfigs[this.currentLOD];
  }

  /**
   * Get the number of LOD levels.
   */
  getLODCount(): number {
    return this.lodConfigs.length;
  }

  /**
   * Get the number of cached tiles in the current LOD.
   */
  getCachedTileCount(): number {
    return this.caches[this.currentLOD].getCachedTileCount();
  }

  /**
   * Get the number of ready tiles in the current LOD.
   */
  getReadyTileCount(): number {
    return this.caches[this.currentLOD].getReadyTileCount();
  }

  /**
   * Get stats for all LOD levels.
   */
  getAllLODStats(): Array<{
    lod: number;
    worldUnitsPerTile: number;
    cachedTiles: number;
    readyTiles: number;
  }> {
    return this.caches.map((cache, index) => ({
      lod: index,
      worldUnitsPerTile: this.lodConfigs[index].worldUnitsPerTile,
      cachedTiles: cache.getCachedTileCount(),
      readyTiles: cache.getReadyTileCount(),
    }));
  }

  /**
   * Clean up all GPU resources.
   */
  destroy(): void {
    for (const cache of this.caches) {
      cache.destroy();
    }
  }
}
