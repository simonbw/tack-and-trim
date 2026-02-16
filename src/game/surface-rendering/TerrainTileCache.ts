/**
 * Terrain Tile Cache
 *
 * Caches terrain height tiles in a GPU texture atlas for efficient rendering.
 * Tiles are computed on-demand and cached until evicted.
 *
 * This class manages:
 * - World-to-tile coordinate mapping
 * - Tile request/render lifecycle
 * - Cache invalidation when terrain changes
 * - Atlas sampling information for the composite shader
 */

import {
  TileAtlas,
  calculateAtlasDimensions,
} from "../../core/graphics/TileAtlas";
import {
  VirtualTextureCache,
  type TileRequest,
} from "../../core/graphics/VirtualTextureCache";
import type { ComputeShader } from "../../core/graphics/webgpu/ComputeShader";
import type { Viewport } from "../wave-physics/WavePhysicsResources";
import type { TerrainResources } from "../world/terrain/TerrainResources";
import { createTerrainTileShader } from "./TerrainTileShader";
import { TerrainTileUniforms } from "./TerrainTileUniforms";
import type { UniformInstance } from "../../core/graphics/UniformStruct";
import type { GPUProfiler } from "../../core/graphics/webgpu/GPUProfiler";

/**
 * Configuration for the terrain tile cache.
 */
export interface TerrainTileCacheConfig {
  /** Size of each tile in pixels (default: 256) */
  tileSize?: number;
  /** Maximum number of tiles to cache (default: 128) */
  maxTiles?: number;
  /** World units per tile at LOD 0 (default: 64) */
  worldUnitsPerTile?: number;
}

/**
 * Information about a visible tile for rendering.
 */
export interface VisibleTile {
  /** Tile key */
  key: string;
  /** Tile X index in world grid */
  tileX: number;
  /** Tile Y index in world grid */
  tileY: number;
  /** World-space left edge */
  worldLeft: number;
  /** World-space top edge */
  worldTop: number;
  /** World-space size */
  worldSize: number;
  /** Atlas slot containing the tile */
  atlasSlot: number;
}

const DEFAULT_TILE_SIZE = 256;
// 512 tiles (23x23 grid) covers ~1500x1500 world units, supporting zoom >= 1.3
// This prevents cache collisions when zoomed out moderately
const DEFAULT_MAX_TILES = 512;
const DEFAULT_WORLD_UNITS_PER_TILE = 64;

/**
 * Terrain tile cache using virtual texturing.
 */
export class TerrainTileCache {
  private device: GPUDevice;
  private readonly tileSize: number;
  private readonly worldUnitsPerTile: number;
  private readonly cache: VirtualTextureCache;
  private readonly atlas: TileAtlas;
  private readonly shader: ComputeShader;
  private readonly uniformBuffer: GPUBuffer;
  private readonly uniforms: UniformInstance<typeof TerrainTileUniforms.fields>;

  private lastTerrainVersion = -1;
  private initialized = false;
  private bindGroup: GPUBindGroup | null = null;
  private lastPackedTerrainBuffer: GPUBuffer | null = null;

  // Current frame's visible tiles
  private visibleTiles: VisibleTile[] = [];

  constructor(device: GPUDevice, config: TerrainTileCacheConfig = {}) {
    this.device = device;

    this.tileSize = config.tileSize ?? DEFAULT_TILE_SIZE;
    const maxTiles = config.maxTiles ?? DEFAULT_MAX_TILES;
    this.worldUnitsPerTile =
      config.worldUnitsPerTile ?? DEFAULT_WORLD_UNITS_PER_TILE;

    // Calculate atlas dimensions
    const { tilesX, tilesY } = calculateAtlasDimensions(maxTiles);

    // Create the virtual texture cache (direct-mapped by tile coordinates)
    this.cache = new VirtualTextureCache({ tilesX, tilesY });

    // Create the atlas texture
    this.atlas = new TileAtlas({
      tileSize: this.tileSize,
      tilesX,
      tilesY,
      format: "r32float",
      label: "Terrain Tile Atlas",
    });

    // Create the tile shader
    this.shader = createTerrainTileShader();

    // Create uniform buffer and instance
    this.uniformBuffer = device.createBuffer({
      size: TerrainTileUniforms.byteSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Terrain Tile Uniform Buffer",
    });
    this.uniforms = TerrainTileUniforms.create();
  }

  /**
   * Initialize the cache (must be called before use).
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    await this.shader.init();
    this.initialized = true;
  }

  /**
   * Check if terrain has changed and invalidate cache if needed.
   *
   * @returns true if cache was invalidated
   */
  checkInvalidation(terrainResources: TerrainResources): boolean {
    const version = terrainResources.getVersion();
    if (version !== this.lastTerrainVersion) {
      this.cache.clear();
      this.lastTerrainVersion = version;
      this.bindGroup = null; // Force rebind
      return true;
    }
    return false;
  }

  /**
   * Update the cache for the current viewport.
   * Returns tile requests that need rendering.
   */
  update(
    viewport: Viewport,
    terrainResources: TerrainResources,
  ): TileRequest[] {
    if (!this.initialized) return [];

    // Calculate which tiles are visible
    const tileKeys = this.calculateVisibleTileKeys(viewport);

    // Request tiles from cache
    const requests = this.cache.requestTiles(tileKeys);

    // Update visible tiles list (only ready tiles)
    this.updateVisibleTiles(viewport, terrainResources);

    return requests;
  }

  /**
   * Render missing tiles to the atlas.
   *
   * Each tile is rendered in a separate command encoder submission to ensure
   * the uniform buffer updates are applied correctly. This is necessary because
   * writeBuffer goes to the queue immediately, but compute pass commands
   * aren't executed until submit().
   */
  renderTiles(
    requests: TileRequest[],
    terrainResources: TerrainResources,
    gpuProfiler?: GPUProfiler,
  ): void {
    if (!this.initialized || requests.length === 0) return;

    const device = this.device;

    // Ensure bind group is up to date
    this.ensureBindGroup(terrainResources);
    if (!this.bindGroup) return;

    // Render each tile with a separate submit to ensure uniforms are applied
    // Only add profiling timestamps to the first tile
    let isFirst = true;

    for (const request of requests) {
      // Skip if this tile was evicted by a later request for the same slot.
      // This happens when multiple visible tiles hash to the same slot in
      // the direct-mapped cache.
      if (this.cache.getTileStatus(request.key) !== "pending") continue;
      // Update uniforms for this tile
      const { tileX, tileY } = this.parseTileKey(request.key);
      const { x: atlasX, y: atlasY } = this.atlas.getSlotPixelCoords(
        request.atlasSlot,
      );

      this.uniforms.set.tileSize(this.tileSize);
      this.uniforms.set.atlasOffsetX(atlasX);
      this.uniforms.set.atlasOffsetY(atlasY);
      this.uniforms.set.contourCount(terrainResources.getContourCount());
      this.uniforms.set.tileWorldLeft(tileX * this.worldUnitsPerTile);
      this.uniforms.set.tileWorldTop(tileY * this.worldUnitsPerTile);
      this.uniforms.set.tileWorldWidth(this.worldUnitsPerTile);
      this.uniforms.set.tileWorldHeight(this.worldUnitsPerTile);

      // Upload uniforms
      this.uniforms.uploadTo(this.uniformBuffer);

      // Create and submit command encoder for this tile
      const commandEncoder = device.createCommandEncoder({
        label: `Terrain Tile ${request.key}`,
      });

      const computePass = commandEncoder.beginComputePass({
        label: `Terrain Tile Compute ${request.key}`,
        timestampWrites: isFirst
          ? gpuProfiler?.getComputeTimestampWrites("surface.terrain")
          : undefined,
      });

      this.shader.dispatch(
        computePass,
        this.bindGroup!,
        this.tileSize,
        this.tileSize,
      );

      computePass.end();
      device.queue.submit([commandEncoder.finish()]);

      this.cache.markTileReady(request.key);
      isFirst = false;
    }
  }

  /**
   * Get the atlas texture view for sampling.
   */
  getAtlasView(): GPUTextureView {
    return this.atlas.view;
  }

  /**
   * Get the atlas texture for binding.
   */
  getAtlasTexture(): GPUTexture {
    return this.atlas.texture;
  }

  /**
   * Get list of currently visible tiles that are ready for rendering.
   */
  getVisibleTiles(): readonly VisibleTile[] {
    return this.visibleTiles;
  }

  /**
   * Get atlas info for shader uniforms.
   */
  getAtlasInfo(): {
    atlasWidth: number;
    atlasHeight: number;
    tileSize: number;
    tilesX: number;
    tilesY: number;
    worldUnitsPerTile: number;
  } {
    return {
      ...this.atlas.getAtlasInfo(),
      worldUnitsPerTile: this.worldUnitsPerTile,
    };
  }

  /**
   * Get the number of cached tiles.
   */
  getCachedTileCount(): number {
    return this.cache.getCachedTileCount();
  }

  /**
   * Get the number of ready tiles.
   */
  getReadyTileCount(): number {
    return this.cache.getReadyTileCount();
  }

  /**
   * Clean up GPU resources.
   */
  destroy(): void {
    this.atlas.destroy();
    this.shader.destroy();
    this.uniformBuffer.destroy();
  }

  // ============ Private Methods ============

  /**
   * Calculate tile keys for all tiles visible in the viewport.
   */
  private calculateVisibleTileKeys(viewport: Viewport): string[] {
    const keys: string[] = [];

    // Calculate tile range that covers viewport (with some margin)
    const margin = this.worldUnitsPerTile * 0.5;
    const minTileX = Math.floor(
      (viewport.left - margin) / this.worldUnitsPerTile,
    );
    const maxTileX = Math.ceil(
      (viewport.left + viewport.width + margin) / this.worldUnitsPerTile,
    );
    const minTileY = Math.floor(
      (viewport.top - margin) / this.worldUnitsPerTile,
    );
    const maxTileY = Math.ceil(
      (viewport.top + viewport.height + margin) / this.worldUnitsPerTile,
    );

    for (let ty = minTileY; ty < maxTileY; ty++) {
      for (let tx = minTileX; tx < maxTileX; tx++) {
        keys.push(this.makeTileKey(tx, ty));
      }
    }

    return keys;
  }

  /**
   * Update the list of visible tiles that are ready.
   */
  private updateVisibleTiles(
    viewport: Viewport,
    _terrainResources: TerrainResources,
  ): void {
    this.visibleTiles = [];

    const margin = this.worldUnitsPerTile * 0.5;
    const minTileX = Math.floor(
      (viewport.left - margin) / this.worldUnitsPerTile,
    );
    const maxTileX = Math.ceil(
      (viewport.left + viewport.width + margin) / this.worldUnitsPerTile,
    );
    const minTileY = Math.floor(
      (viewport.top - margin) / this.worldUnitsPerTile,
    );
    const maxTileY = Math.ceil(
      (viewport.top + viewport.height + margin) / this.worldUnitsPerTile,
    );

    for (let ty = minTileY; ty < maxTileY; ty++) {
      for (let tx = minTileX; tx < maxTileX; tx++) {
        const key = this.makeTileKey(tx, ty);
        const cached = this.cache.getTile(key);
        if (cached) {
          this.visibleTiles.push({
            key,
            tileX: tx,
            tileY: ty,
            worldLeft: tx * this.worldUnitsPerTile,
            worldTop: ty * this.worldUnitsPerTile,
            worldSize: this.worldUnitsPerTile,
            atlasSlot: cached.atlasSlot,
          });
        }
      }
    }
  }

  /**
   * Create a tile key from coordinates.
   */
  private makeTileKey(tileX: number, tileY: number): string {
    return `${tileX},${tileY}`;
  }

  /**
   * Parse tile coordinates from a key.
   */
  private parseTileKey(key: string): { tileX: number; tileY: number } {
    const [x, y] = key.split(",").map(Number);
    return { tileX: x, tileY: y };
  }

  /**
   * Ensure the bind group is up to date.
   */
  private ensureBindGroup(terrainResources: TerrainResources): void {
    const packedTerrainBuffer = terrainResources.packedTerrainBuffer;

    const needsRebuild =
      !this.bindGroup || this.lastPackedTerrainBuffer !== packedTerrainBuffer;

    if (!needsRebuild) return;

    this.bindGroup = this.shader.createBindGroup({
      params: { buffer: this.uniformBuffer },
      packedTerrain: { buffer: packedTerrainBuffer },
      atlasTexture: this.atlas.view,
    });

    this.lastPackedTerrainBuffer = packedTerrainBuffer;
  }
}
