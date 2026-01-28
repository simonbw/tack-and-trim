/**
 * Metadata stored for each cached tile
 */
export interface CachedTile<T> {
  /** Level of detail (0 = highest resolution) */
  lod: number;
  /** Tile X coordinate */
  tileX: number;
  /** Tile Y coordinate */
  tileY: number;
  /** Index in the GPU texture array */
  textureIndex: number;
  /** Last frame this tile was accessed (for LRU eviction) */
  lastAccessFrame: number;
  /** Custom metadata for this tile */
  data: T;
}

/**
 * LRU cache for virtual texture tiles
 *
 * Manages a fixed-size pool of texture array indices, evicting least-recently-used
 * tiles when the cache is full.
 *
 * @template T - Custom metadata type for each tile
 */
export class TileCache<T> {
  private tiles: Map<string, CachedTile<T>> = new Map();
  private freeIndices: number[] = [];
  private currentFrame: number = 0;
  private readonly maxTiles: number;

  constructor(maxTiles: number) {
    this.maxTiles = maxTiles;
    // Initialize free indices pool (0 to maxTiles-1)
    for (let i = 0; i < maxTiles; i++) {
      this.freeIndices.push(i);
    }
  }

  /**
   * Get a cached tile by coordinates
   */
  get(lod: number, tileX: number, tileY: number): CachedTile<T> | undefined {
    const key = this.makeKey(lod, tileX, tileY);
    return this.tiles.get(key);
  }

  /**
   * Allocate a new tile, evicting LRU tile if cache is full
   *
   * @param lod Level of detail
   * @param tileX Tile X coordinate
   * @param tileY Tile Y coordinate
   * @param data Custom metadata for this tile
   * @returns The allocated tile
   */
  allocate(lod: number, tileX: number, tileY: number, data: T): CachedTile<T> {
    const key = this.makeKey(lod, tileX, tileY);

    // Check if already exists
    const existing = this.tiles.get(key);
    if (existing) {
      existing.lastAccessFrame = this.currentFrame;
      existing.data = data;
      return existing;
    }

    // Get texture index (evict LRU if needed)
    let textureIndex: number;
    if (this.freeIndices.length > 0) {
      textureIndex = this.freeIndices.pop()!;
    } else {
      // Cache full - evict LRU tile
      textureIndex = this.evictLRU();
    }

    // Create new tile
    const tile: CachedTile<T> = {
      lod,
      tileX,
      tileY,
      textureIndex,
      lastAccessFrame: this.currentFrame,
      data,
    };

    this.tiles.set(key, tile);
    return tile;
  }

  /**
   * Mark a tile as recently accessed (updates LRU tracking)
   */
  touch(tile: CachedTile<T>): void {
    tile.lastAccessFrame = this.currentFrame;
  }

  /**
   * Increment the frame counter (call once per frame)
   */
  advanceFrame(): void {
    this.currentFrame++;
  }

  /**
   * Clear all cached tiles
   */
  clear(): void {
    this.tiles.clear();
    this.freeIndices = [];
    for (let i = 0; i < this.maxTiles; i++) {
      this.freeIndices.push(i);
    }
  }

  /**
   * Get cache statistics
   */
  getStats(): { size: number; maxSize: number; freeIndices: number } {
    return {
      size: this.tiles.size,
      maxSize: this.maxTiles,
      freeIndices: this.freeIndices.length,
    };
  }

  /**
   * Generate unique key for tile coordinates
   */
  private makeKey(lod: number, tileX: number, tileY: number): string {
    return `${lod},${tileX},${tileY}`;
  }

  /**
   * Evict the least recently used tile
   * @returns The texture index that was freed
   */
  private evictLRU(): number {
    let oldestTile: CachedTile<T> | null = null;
    let oldestKey: string | null = null;

    // Find tile with oldest lastAccessFrame
    for (const [key, tile] of this.tiles) {
      if (!oldestTile || tile.lastAccessFrame < oldestTile.lastAccessFrame) {
        oldestTile = tile;
        oldestKey = key;
      }
    }

    if (!oldestTile || !oldestKey) {
      throw new Error("TileCache: Cannot evict from empty cache");
    }

    // Remove from map and return its texture index
    this.tiles.delete(oldestKey);
    return oldestTile.textureIndex;
  }
}
