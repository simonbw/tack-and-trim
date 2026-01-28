import { TileCache, type CachedTile } from "./TileCache";
import type { TileCompute } from "./TileCompute";
import type { BindingsDefinition } from "../ShaderBindings";
import { getWebGPU } from "../WebGPUDevice";
import type { AABB } from "../../../physics/collision/AABB";

/**
 * Arbitrary metadata stored per tile
 */
type TileMetadata = Record<string, unknown>;

/**
 * Configuration for VirtualTexture
 */
export interface VirtualTextureConfig<B extends BindingsDefinition> {
  /** Size of each tile in pixels (default 128) */
  tileSize: number;
  /** Maximum number of cached tiles (default 512) */
  maxTiles: number;
  /** Compute shader for generating tiles */
  tileCompute: TileCompute<B>;
  /** Texture format */
  format: GPUTextureFormat;
  /** Label for debugging */
  label?: string;
}

/**
 * Tile request for deferred computation
 */
interface TileRequest {
  lod: number;
  tileX: number;
  tileY: number;
}

/**
 * Virtual texture system with LOD support.
 *
 * Features:
 * - Tile-based caching with LRU eviction
 * - LOD fallback chain (request LOD 2 → check 2 → check 1 → check 0)
 * - GPU texture array for efficient shader access
 * - Deferred tile computation (cap at 4-8 tiles per frame)
 *
 * @template B - Bindings definition for the tile compute shader
 */
export class VirtualTexture<B extends BindingsDefinition> {
  private readonly config: VirtualTextureConfig<B>;
  private readonly cache: TileCache<TileMetadata>;
  private readonly textureArray: GPUTexture;
  private pendingTiles: TileRequest[] = [];
  private readonly device: GPUDevice;

  // Computation settings
  private readonly maxTilesPerFrame = 8;
  private computedThisFrame = 0;

  constructor(config: VirtualTextureConfig<B>) {
    this.config = config;
    this.device = getWebGPU().device;

    // Initialize tile cache
    this.cache = new TileCache<TileMetadata>(config.maxTiles);

    // Create GPU texture array (512 layers × tileSize×tileSize)
    this.textureArray = this.device.createTexture({
      label: (config.label || "VirtualTexture") + " Array",
      size: {
        width: config.tileSize,
        height: config.tileSize,
        depthOrArrayLayers: config.maxTiles,
      },
      format: config.format,
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST,
    });
  }

  /**
   * Request tiles needed to render a world-space rectangle at a given LOD.
   *
   * Tiles are queued for deferred computation if not already cached.
   *
   * @param rect World-space AABB
   * @param lod Level of detail (0 = highest resolution)
   */
  requestTilesForRect(rect: AABB, lod: number): void {
    const { tileSize } = this.config;
    const scale = Math.pow(2, lod);
    const worldTileSize = tileSize * scale;

    // Calculate tile range
    const minTileX = Math.floor(rect.lowerBound.x / worldTileSize);
    const minTileY = Math.floor(rect.lowerBound.y / worldTileSize);
    const maxTileX = Math.floor(rect.upperBound.x / worldTileSize);
    const maxTileY = Math.floor(rect.upperBound.y / worldTileSize);

    // Request each tile
    for (let tileY = minTileY; tileY <= maxTileY; tileY++) {
      for (let tileX = minTileX; tileX <= maxTileX; tileX++) {
        this.requestTile(lod, tileX, tileY);
      }
    }
  }

  /**
   * Get a cached tile with LOD fallback.
   *
   * If the requested LOD is not available, falls back to coarser LODs (2→1→0).
   *
   * @param lod Level of detail
   * @param tileX Tile X coordinate
   * @param tileY Tile Y coordinate
   * @returns Cached tile or undefined if not available at any LOD
   */
  getTile(
    lod: number,
    tileX: number,
    tileY: number,
  ): CachedTile<TileMetadata> | undefined {
    // Try requested LOD first
    let tile = this.cache.get(lod, tileX, tileY);
    if (tile) {
      this.cache.touch(tile);
      return tile;
    }

    // Fallback to coarser LODs (2→1→0)
    let fallbackTileX = tileX;
    let fallbackTileY = tileY;

    for (let fallbackLod = lod - 1; fallbackLod >= 0; fallbackLod--) {
      fallbackTileX = Math.floor(fallbackTileX / 2);
      fallbackTileY = Math.floor(fallbackTileY / 2);

      tile = this.cache.get(fallbackLod, fallbackTileX, fallbackTileY);
      if (tile) {
        this.cache.touch(tile);
        return tile;
      }
    }

    return undefined; // No tile available at any LOD
  }

  /**
   * Update the virtual texture system.
   * Call once per frame to process pending tile computations.
   *
   * @param _dt Delta time (unused, for future use)
   */
  update(_dt: number): void {
    this.computedThisFrame = 0;

    // Process pending tiles (cap at maxTilesPerFrame)
    while (
      this.pendingTiles.length > 0 &&
      this.computedThisFrame < this.maxTilesPerFrame
    ) {
      const request = this.pendingTiles.shift()!;
      this.computeTile(request.lod, request.tileX, request.tileY);
      this.computedThisFrame++;
    }

    // Advance frame counter for LRU tracking
    this.cache.advanceFrame();
  }

  /**
   * Invalidate all cached tiles and clear pending requests.
   */
  invalidate(): void {
    this.cache.clear();
    this.pendingTiles = [];
  }

  /**
   * Get the GPU texture array for shader binding.
   */
  getTextureArray(): GPUTexture {
    return this.textureArray;
  }

  /**
   * Get cache statistics.
   */
  getStats(): {
    cached: number;
    pending: number;
    computedThisFrame: number;
  } {
    const cacheStats = this.cache.getStats();
    return {
      cached: cacheStats.size,
      pending: this.pendingTiles.length,
      computedThisFrame: this.computedThisFrame,
    };
  }

  /**
   * Clean up resources.
   */
  destroy(): void {
    this.textureArray.destroy();
    this.cache.clear();
    this.pendingTiles = [];
  }

  /**
   * Request a single tile (internal).
   */
  private requestTile(lod: number, tileX: number, tileY: number): void {
    // Check if already cached
    if (this.cache.get(lod, tileX, tileY)) {
      return;
    }

    // Check if already pending
    const isPending = this.pendingTiles.some(
      (req) => req.lod === lod && req.tileX === tileX && req.tileY === tileY,
    );
    if (isPending) {
      return;
    }

    // Add to pending queue
    this.pendingTiles.push({ lod, tileX, tileY });
  }

  /**
   * Compute a tile using the GPU (internal).
   */
  private computeTile(lod: number, tileX: number, tileY: number): void {
    // Allocate cache entry
    const tile = this.cache.allocate(lod, tileX, tileY, {
      computed: true,
      timestamp: Date.now(),
    });

    // Create command encoder
    const commandEncoder = this.device.createCommandEncoder({
      label:
        (this.config.label || "VirtualTexture") +
        " Compute Tile " +
        lod +
        "," +
        tileX +
        "," +
        tileY,
    });

    // Get texture view for this layer
    const textureView = this.textureArray.createView({
      dimension: "2d",
      baseArrayLayer: tile.textureIndex,
      arrayLayerCount: 1,
    });

    // Create bind group for this tile
    // Note: In Phase 1, this is a stub. Phase 2+ will pass actual tile parameters.
    const bindGroup = this.config.tileCompute.createBindGroup({
      output: textureView,
    } as any); // TODO: Type this properly in Phase 2

    // Dispatch compute shader
    this.config.tileCompute.computeTile(
      commandEncoder,
      bindGroup,
      this.config.tileSize,
    );

    // Submit to GPU
    this.device.queue.submit([commandEncoder.finish()]);
  }
}
