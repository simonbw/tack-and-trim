/**
 * LOD Terrain Tile Cache — Sliding Window
 *
 * Maintains a sliding window of 3 TerrainTileCache instances that follow the
 * camera zoom: one for the current LOD level, one finer, one coarser.
 *
 * LOD levels are computed from a formula rather than a static list:
 *   worldUnitsPerTile(level) = BASE_WORLD_UNITS * SCALE^level
 *   zoomThreshold(level)     = BASE_ZOOM * (1/SCALE)^level
 *
 * Level 0 is highest detail. No upper bound — infinite zoom out.
 *
 * Memory: 3 × 256-tile atlas = 192 MB fixed, regardless of zoom range.
 */

import type { GPUProfiler } from "../../core/graphics/webgpu/GPUProfiler";
import type { Viewport } from "../wave-physics/WavePhysicsResources";
import type { TerrainResources } from "../world/terrain/TerrainResources";
import { TerrainTileCache, type VisibleTile } from "./TerrainTileCache";
import type { TileRequest } from "../../core/graphics/VirtualTextureCache";

const BASE_WORLD_UNITS = 16;
const SCALE_FACTOR = 4;
const BASE_ZOOM = 48.0;
const DEFAULT_MAX_TILES = 256;
const DEFAULT_HYSTERESIS = 0.05;
const DEFAULT_ADJACENT_TILE_BUDGET = 2;

interface CacheSlot {
  level: number;
  cache: TerrainTileCache;
}

/**
 * Compute world units per tile for a given LOD level.
 */
function worldUnitsForLevel(level: number): number {
  return BASE_WORLD_UNITS * SCALE_FACTOR ** level;
}

/**
 * Compute the zoom threshold for a given LOD level.
 * At or above this zoom, this level is the ideal LOD.
 */
function zoomThresholdForLevel(level: number): number {
  return BASE_ZOOM * (1 / SCALE_FACTOR) ** level;
}

/**
 * Compute the ideal LOD level for a given zoom.
 * Higher zoom → lower level (finer detail).
 */
function levelForZoom(zoom: number): number {
  if (zoom >= BASE_ZOOM) return 0;
  // level = log(BASE_ZOOM / zoom) / log(SCALE_FACTOR)
  const level = Math.floor(Math.log(BASE_ZOOM / zoom) / Math.log(SCALE_FACTOR));
  return Math.max(0, level);
}

export interface LODConfig {
  worldUnitsPerTile: number;
  maxTiles: number;
  minZoom: number;
}

/**
 * LOD manager with sliding window of 3 caches.
 */
export class LODTerrainTileCache {
  private device: GPUDevice;
  private readonly maxTilesPerCache: number;
  private readonly hysteresis: number;
  private readonly adjacentTileBudget: number;

  private slots: [CacheSlot, CacheSlot, CacheSlot];
  private currentLevel = 0;
  private initialized = false;

  // Queued adjacent tile requests for budget-limited rendering
  private adjacentRequests: { slot: CacheSlot; requests: TileRequest[] }[] = [];

  constructor(device: GPUDevice) {
    this.device = device;
    this.maxTilesPerCache = DEFAULT_MAX_TILES;
    this.hysteresis = DEFAULT_HYSTERESIS;
    this.adjacentTileBudget = DEFAULT_ADJACENT_TILE_BUDGET;

    // Initialize window at level 0: [clamped(0-1)=0, 0, 1]
    this.slots = [
      this.createSlot(0), // level max(0, current-1) = 0
      this.createSlot(0), // current
      this.createSlot(1), // current+1
    ];
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await Promise.all(this.slots.map((s) => s.cache.init()));
    this.initialized = true;
  }

  /**
   * Select LOD based on zoom with hysteresis, reshuffle caches if level changes.
   */
  private selectLOD(zoom: number): void {
    const idealLevel = levelForZoom(zoom);

    if (idealLevel === this.currentLevel) return;

    // Apply hysteresis
    const currentThreshold = zoomThresholdForLevel(this.currentLevel);

    if (idealLevel < this.currentLevel) {
      // Zooming in → finer detail (lower level number)
      const threshold = currentThreshold * (1 + this.hysteresis);
      if (zoom < threshold) return;
    } else {
      // Zooming out → coarser detail (higher level number)
      const threshold = currentThreshold * (1 - this.hysteresis);
      if (zoom > threshold) return;
    }

    this.reshuffleCaches(idealLevel);
  }

  /**
   * Reshuffle the 3 cache slots for a new current level.
   * Reuses caches whose levels are still in the new window.
   */
  private reshuffleCaches(newLevel: number): void {
    this.currentLevel = newLevel;

    const newWindowLevels = [Math.max(0, newLevel - 1), newLevel, newLevel + 1];

    // Build a map of old slots by level for reuse
    const oldSlotsByLevel = new Map<number, CacheSlot>();
    for (const slot of this.slots) {
      oldSlotsByLevel.set(slot.level, slot);
    }

    const newSlots: [CacheSlot, CacheSlot, CacheSlot] = [null!, null!, null!];
    const reused = new Set<CacheSlot>();

    // Assign reusable caches, prioritizing the current slot (index 1) first
    const assignOrder = [1, 0, 2];
    for (const i of assignOrder) {
      const level = newWindowLevels[i];
      const existing = oldSlotsByLevel.get(level);
      if (existing && !reused.has(existing)) {
        newSlots[i] = existing;
        reused.add(existing);
      }
    }

    // Destroy old slots that aren't reused, create new ones
    for (const slot of this.slots) {
      if (!reused.has(slot)) {
        slot.cache.destroy();
      }
    }

    for (let i = 0; i < 3; i++) {
      if (!newSlots[i]) {
        const slot = this.createSlot(newWindowLevels[i]);
        if (this.initialized) {
          // Fire-and-forget init for dynamically created caches.
          // The cache handles the not-initialized state gracefully.
          slot.cache.init();
        }
        newSlots[i] = slot;
      }
    }

    this.slots = newSlots;
  }

  private createSlot(level: number): CacheSlot {
    return {
      level,
      cache: new TerrainTileCache(this.device, {
        worldUnitsPerTile: worldUnitsForLevel(level),
        maxTiles: this.maxTilesPerCache,
      }),
    };
  }

  private getCurrentSlot(): CacheSlot {
    return this.slots[1];
  }

  checkInvalidation(terrainResources: TerrainResources): boolean {
    let invalidated = false;
    for (const slot of this.slots) {
      if (slot.cache.checkInvalidation(terrainResources)) {
        invalidated = true;
      }
    }
    return invalidated;
  }

  /**
   * Update all 3 slots. Returns only the current slot's tile requests for the caller.
   * Adjacent slots are pre-warmed and their requests queued for budget-limited rendering.
   */
  update(
    viewport: Viewport,
    zoom: number,
    terrainResources: TerrainResources,
  ): TileRequest[] {
    if (!this.initialized) return [];

    this.selectLOD(zoom);

    // Update all slots with current viewport
    this.adjacentRequests = [];

    let currentRequests: TileRequest[] = [];
    for (const slot of this.slots) {
      const requests = slot.cache.update(viewport, terrainResources);
      if (slot === this.getCurrentSlot()) {
        currentRequests = requests;
      } else if (requests.length > 0) {
        this.adjacentRequests.push({ slot, requests });
      }
    }

    return currentRequests;
  }

  /**
   * Render current cache's tiles (from caller requests),
   * plus adjacent tiles up to budget.
   */
  renderTiles(
    requests: TileRequest[],
    terrainResources: TerrainResources,
    gpuProfiler?: GPUProfiler,
  ): void {
    if (!this.initialized) return;

    // Render current LOD's tiles
    if (requests.length > 0) {
      this.getCurrentSlot().cache.renderTiles(
        requests,
        terrainResources,
        gpuProfiler,
      );
    }

    // Render adjacent tiles with budget cap
    let budget = this.adjacentTileBudget;
    for (const { slot, requests: adjRequests } of this.adjacentRequests) {
      if (budget <= 0) break;
      const limited = adjRequests.slice(0, budget);
      slot.cache.renderTiles(limited, terrainResources);
      budget -= limited.length;
    }
  }

  getAtlasView(): GPUTextureView {
    return this.getCurrentSlot().cache.getAtlasView();
  }

  getAtlasTexture(): GPUTexture {
    return this.getCurrentSlot().cache.getAtlasTexture();
  }

  getAtlasInfo(): {
    atlasWidth: number;
    atlasHeight: number;
    tileSize: number;
    tilesX: number;
    tilesY: number;
    worldUnitsPerTile: number;
  } {
    return this.getCurrentSlot().cache.getAtlasInfo();
  }

  getVisibleTiles(): readonly VisibleTile[] {
    return this.getCurrentSlot().cache.getVisibleTiles();
  }

  getCurrentLOD(): number {
    return this.currentLevel;
  }

  getCurrentLODConfig(): LODConfig {
    const level = this.currentLevel;
    return {
      worldUnitsPerTile: worldUnitsForLevel(level),
      maxTiles: this.maxTilesPerCache,
      minZoom: zoomThresholdForLevel(level),
    };
  }

  getCachedTileCount(): number {
    return this.getCurrentSlot().cache.getCachedTileCount();
  }

  getReadyTileCount(): number {
    return this.getCurrentSlot().cache.getReadyTileCount();
  }

  getAllLODStats(): Array<{
    lod: number;
    worldUnitsPerTile: number;
    cachedTiles: number;
    readyTiles: number;
  }> {
    return this.slots.map((slot) => ({
      lod: slot.level,
      worldUnitsPerTile: worldUnitsForLevel(slot.level),
      cachedTiles: slot.cache.getCachedTileCount(),
      readyTiles: slot.cache.getReadyTileCount(),
    }));
  }

  destroy(): void {
    for (const slot of this.slots) {
      slot.cache.destroy();
    }
  }
}
