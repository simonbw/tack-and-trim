/**
 * Manages the tile grid and scoring for GPU wind computation.
 *
 * Responsibilities:
 * - Track tiles and their scores
 * - Accumulate scores from query forecasts
 * - Select which tiles to compute each frame
 * - Find tiles for world-space queries
 */

import type { WindQueryForecast } from "../WindQuerier";
import {
  DEFAULT_WIND_TILE_CONFIG,
  getWindTileBounds,
  WindTile,
  WindTileGridConfig,
  WindTileId,
  toWindTileId,
  worldToWindGrid,
} from "./WindTileTypes";

/**
 * Manages the tile grid and scoring for wind physics computation.
 */
export class WindTileManager {
  private config: WindTileGridConfig;
  private tiles = new Map<WindTileId, WindTile>();
  private activeTiles: WindTile[] = [];

  constructor(config: Partial<WindTileGridConfig> = {}) {
    this.config = { ...DEFAULT_WIND_TILE_CONFIG, ...config };
  }

  /**
   * Reset scores for new frame.
   */
  resetScores(): void {
    for (const tile of this.tiles.values()) {
      tile.score = 0;
    }
  }

  /**
   * Accumulate scores from a query forecast.
   * Distributes the query count proportionally across overlapping tiles.
   */
  accumulateScore(forecast: WindQueryForecast): void {
    const { aabb, queryCount } = forecast;
    if (queryCount <= 0) return;

    // Find all tiles that overlap this AABB
    const minGridX = Math.floor(aabb.minX / this.config.tileSize);
    const maxGridX = Math.floor(aabb.maxX / this.config.tileSize);
    const minGridY = Math.floor(aabb.minY / this.config.tileSize);
    const maxGridY = Math.floor(aabb.maxY / this.config.tileSize);

    const tileCount = (maxGridX - minGridX + 1) * (maxGridY - minGridY + 1);
    const scorePerTile = queryCount / tileCount;

    for (let gx = minGridX; gx <= maxGridX; gx++) {
      for (let gy = minGridY; gy <= maxGridY; gy++) {
        const tile = this.getOrCreateTile(gx, gy);
        tile.score += scorePerTile;
      }
    }
  }

  /**
   * Select which tiles to compute this frame.
   * Returns tiles sorted by score (highest first), limited to maxTilesPerFrame.
   */
  selectTilesToCompute(_currentTime: number): WindTile[] {
    // Filter tiles above threshold
    const candidates = Array.from(this.tiles.values()).filter(
      (t) => t.score >= this.config.minScoreThreshold,
    );

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);

    // Take top K
    this.activeTiles = candidates.slice(0, this.config.maxTilesPerFrame);

    return this.activeTiles;
  }

  /**
   * Get or create a tile at grid coordinates.
   */
  private getOrCreateTile(gridX: number, gridY: number): WindTile {
    const id = toWindTileId(gridX, gridY);
    let tile = this.tiles.get(id);

    if (!tile) {
      tile = {
        id,
        gridX,
        gridY,
        bounds: getWindTileBounds(gridX, gridY, this.config.tileSize),
        score: 0,
        lastComputedTime: -Infinity,
        bufferIndex: -1,
      };
      this.tiles.set(id, tile);
    }

    return tile;
  }

  /**
   * Find tile containing a world point.
   * Returns null if no tile exists or tile is not active (no buffer assigned).
   */
  findTileForPoint(worldX: number, worldY: number): WindTile | null {
    const [gridX, gridY] = worldToWindGrid(
      worldX,
      worldY,
      this.config.tileSize,
    );
    const id = toWindTileId(gridX, gridY);
    const tile = this.tiles.get(id);

    // Only return if tile is active (has a buffer assigned)
    return tile && tile.bufferIndex >= 0 ? tile : null;
  }

  /**
   * Check if a point is within any active tile.
   */
  isPointInActiveTile(worldX: number, worldY: number): boolean {
    return this.findTileForPoint(worldX, worldY) !== null;
  }

  /**
   * Get active tiles for this frame.
   */
  getActiveTiles(): readonly WindTile[] {
    return this.activeTiles;
  }

  /**
   * Get the tile configuration.
   */
  getConfig(): WindTileGridConfig {
    return this.config;
  }

  /**
   * Get the number of tracked tiles.
   */
  getTileCount(): number {
    return this.tiles.size;
  }

  /**
   * Get the number of active tiles this frame.
   */
  getActiveTileCount(): number {
    return this.activeTiles.length;
  }

  /**
   * Cleanup old unused tiles to prevent memory growth.
   * Removes tiles that haven't been computed recently and have no buffer assigned.
   */
  pruneOldTiles(currentTime: number, maxAge: number = 10): void {
    for (const [id, tile] of this.tiles) {
      if (
        currentTime - tile.lastComputedTime > maxAge &&
        tile.bufferIndex < 0
      ) {
        this.tiles.delete(id);
      }
    }
  }

  /**
   * Clear all tiles and active state.
   */
  clear(): void {
    this.tiles.clear();
    this.activeTiles = [];
  }
}
