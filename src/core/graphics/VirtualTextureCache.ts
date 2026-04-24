/**
 * Virtual Texture Cache - Direct-mapped tile caching system.
 *
 * Manages a cache of rendered tiles where each tile coordinate maps to a
 * deterministic slot via modulo. This allows shaders to compute the slot
 * from world coordinates without an indirection texture.
 *
 * When a new tile needs a slot that's occupied by a different tile,
 * the old tile is evicted (direct-mapped cache behavior).
 */

/**
 * State of a tile in the cache.
 */
export type TileStatus = "empty" | "pending" | "ready";

/**
 * Internal tile state tracking.
 */
interface TileState {
  /** The tile key occupying this slot (packed as (tileX<<16)|(tileY&0xffff)) */
  key: number;
  status: TileStatus;
  /** Parsed tile coordinates for quick access */
  tileX: number;
  tileY: number;
}

/**
 * Request to render a tile.
 */
export interface TileRequest {
  /** Packed tile key: (tileX<<16)|(tileY&0xffff). Coordinates must fit in signed int16. */
  key: number;
  /** Atlas slot where the tile should be rendered */
  atlasSlot: number;
}

/**
 * Information about a cached tile.
 */
export interface CachedTile {
  /** Packed tile key */
  key: number;
  /** Atlas slot containing the tile data */
  atlasSlot: number;
}

/**
 * Pack tile coordinates into a single 32-bit int key.
 * Each coordinate must fit in signed int16 (±32767).
 */
export function packTileKey(tileX: number, tileY: number): number {
  return ((tileX & 0xffff) << 16) | (tileY & 0xffff);
}

/**
 * Unpack the X coordinate (sign-extended) from a packed tile key.
 */
export function unpackTileX(key: number): number {
  return key >> 16;
}

/**
 * Unpack the Y coordinate (sign-extended) from a packed tile key.
 */
export function unpackTileY(key: number): number {
  return (key << 16) >> 16;
}

/**
 * Configuration for the virtual texture cache.
 */
export interface VirtualTextureCacheConfig {
  /** Number of tiles in X direction in the atlas */
  tilesX: number;
  /** Number of tiles in Y direction in the atlas */
  tilesY: number;
}

/**
 * Direct-mapped virtual texture cache.
 *
 * Tiles are stored at deterministic slots computed from their coordinates:
 *   slot = (tileY % tilesY) * tilesX + (tileX % tilesX)
 *
 * This allows shaders to sample the atlas using only world coordinates,
 * without needing an indirection texture.
 *
 * Usage:
 * 1. Call `requestTiles()` with keys of tiles needed this frame
 * 2. Render tiles returned by `requestTiles()` (those with status 'pending')
 * 3. Call `markTileReady()` for each tile after rendering
 * 4. Shaders can sample using: slot = worldToTileCoord % atlasSize
 */
export class VirtualTextureCache {
  private readonly tilesX: number;
  private readonly tilesY: number;
  private readonly maxTiles: number;

  /** Slots indexed by slot number, null if empty */
  private readonly slots: (TileState | null)[];

  /** Map from tile key to slot for quick lookup */
  private readonly keyToSlot: Map<number, number> = new Map();

  constructor(config: VirtualTextureCacheConfig) {
    this.tilesX = config.tilesX;
    this.tilesY = config.tilesY;
    this.maxTiles = config.tilesX * config.tilesY;

    // Initialize all slots as empty
    this.slots = new Array(this.maxTiles).fill(null);
  }

  /**
   * Compute the slot for a tile based on its coordinates.
   * This must match the shader's computation.
   */
  computeSlot(tileX: number, tileY: number): number {
    // Handle negative coordinates with proper modulo
    let slotX = tileX % this.tilesX;
    let slotY = tileY % this.tilesY;
    if (slotX < 0) slotX += this.tilesX;
    if (slotY < 0) slotY += this.tilesY;
    return slotY * this.tilesX + slotX;
  }

  /**
   * Request tiles for the current frame.
   *
   * Returns a list of tiles that need to be rendered (status: pending).
   * If a slot is occupied by a different tile, that tile is evicted.
   *
   * @param keys - Array of packed tile keys needed this frame
   * @returns Array of tile requests that need rendering
   */
  requestTiles(keys: number[]): TileRequest[] {
    const requests: TileRequest[] = [];

    for (const key of keys) {
      const tileX = unpackTileX(key);
      const tileY = unpackTileY(key);
      const slot = this.computeSlot(tileX, tileY);
      const existing = this.slots[slot];

      if (existing && existing.key === key) {
        // Tile is already in its slot
        if (existing.status === "pending") {
          requests.push({ key, atlasSlot: slot });
        }
        // If ready, nothing to do
      } else {
        // Slot is empty or occupied by a different tile - evict and allocate
        if (existing) {
          // Evict the old tile
          this.keyToSlot.delete(existing.key);
        }

        // Allocate new tile
        const state: TileState = {
          key,
          status: "pending",
          tileX,
          tileY,
        };
        this.slots[slot] = state;
        this.keyToSlot.set(key, slot);
        requests.push({ key, atlasSlot: slot });
      }
    }

    return requests;
  }

  /**
   * Mark a tile as ready (rendered and available for sampling).
   */
  markTileReady(key: number): void {
    const slot = this.keyToSlot.get(key);
    if (slot !== undefined) {
      const state = this.slots[slot];
      if (state && state.key === key) {
        state.status = "ready";
      }
    }
  }

  /**
   * Get a cached tile by key.
   *
   * @returns The cached tile info if ready, null otherwise
   */
  getTile(key: number): CachedTile | null {
    const slot = this.keyToSlot.get(key);
    if (slot !== undefined) {
      const state = this.slots[slot];
      if (state && state.key === key && state.status === "ready") {
        return { key, atlasSlot: slot };
      }
    }
    return null;
  }

  /**
   * Get the status of a tile.
   */
  getTileStatus(key: number): TileStatus {
    const slot = this.keyToSlot.get(key);
    if (slot !== undefined) {
      const state = this.slots[slot];
      if (state && state.key === key) {
        return state.status;
      }
    }
    return "empty";
  }

  /**
   * Clear all cached tiles.
   */
  clear(): void {
    for (let i = 0; i < this.maxTiles; i++) {
      this.slots[i] = null;
    }
    this.keyToSlot.clear();
  }

  /**
   * Get the number of cached tiles (pending + ready).
   */
  getCachedTileCount(): number {
    return this.keyToSlot.size;
  }

  /**
   * Get the number of ready tiles.
   */
  getReadyTileCount(): number {
    let count = 0;
    for (const slot of this.keyToSlot.values()) {
      const state = this.slots[slot];
      if (state && state.status === "ready") count++;
    }
    return count;
  }
}
