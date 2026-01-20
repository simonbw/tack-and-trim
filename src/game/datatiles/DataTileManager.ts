/**
 * Manages the data tile grid and scoring for GPU computation.
 *
 * Responsibilities:
 * - Track active tiles and their scores
 * - Compute scores from query forecasts fresh each frame
 * - Select which tiles to compute each frame
 * - Find tiles for world-space queries
 */

import type { AABB } from "../../core/util/SparseSpatialHash";
import type {
  QueryForecast,
  DataTile,
  DataTileGridConfig,
  DataTileId,
} from "./DataTileTypes";

/**
 * Convert grid coordinates to DataTileId.
 */
export function toDataTileId(gridX: number, gridY: number): DataTileId {
  return `${gridX},${gridY}`;
}

/**
 * Convert world coordinates to grid coordinates.
 */
export function worldToTileGrid(
  worldX: number,
  worldY: number,
  tileSize: number,
): [number, number] {
  return [Math.floor(worldX / tileSize), Math.floor(worldY / tileSize)];
}

/**
 * Get the world-space AABB for a tile at given grid coordinates.
 */
export function getTileBounds(
  gridX: number,
  gridY: number,
  tileSize: number,
): AABB {
  const worldX = gridX * tileSize;
  const worldY = gridY * tileSize;
  return {
    minX: worldX,
    minY: worldY,
    maxX: worldX + tileSize,
    maxY: worldY + tileSize,
  };
}

/**
 * Manages the data tile grid and scoring for GPU computation.
 *
 * Simplified implementation that computes scores fresh each frame.
 * Only tracks active tiles (those with buffer assignments).
 */
export class DataTileManager {
  private config: DataTileGridConfig;

  // Only track active tiles (those with buffer assignments)
  private activeTiles = new Map<DataTileId, DataTile>();

  // Temporary map for fresh-each-frame scoring
  private tileScores = new Map<DataTileId, number>();

  constructor(config: DataTileGridConfig) {
    this.config = config;
  }

  /**
   * Select tiles from forecasts for this frame.
   * Computes all tile scores from forecasts in one pass.
   *
   * @param forecasts Iterable of query forecasts
   * @param time Current game time
   * @returns Selected tiles sorted by score (highest first), limited to maxTilesPerFrame
   */
  selectTilesFromForecasts(
    forecasts: Iterable<QueryForecast>,
    _time: number,
  ): DataTile[] {
    // Clear previous scores
    this.tileScores.clear();

    // Accumulate scores from all forecasts
    for (const forecast of forecasts) {
      this.accumulateScore(forecast);
    }

    // Build candidate tiles from scores
    const candidates: DataTile[] = [];
    for (const [id, score] of this.tileScores) {
      if (score >= this.config.minScoreThreshold) {
        // Parse grid coordinates from id
        const [gridX, gridY] = id.split(",").map(Number);

        // Reuse existing tile if available, otherwise create new one
        let tile = this.activeTiles.get(id);
        if (!tile) {
          tile = {
            id,
            gridX,
            gridY,
            bounds: getTileBounds(gridX, gridY, this.config.tileSize),
            score: 0,
            lastComputedTime: -Infinity,
            bufferIndex: -1,
          };
        }
        tile.score = score;
        candidates.push(tile);
      }
    }

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);

    // Take top K
    const selected = candidates.slice(0, this.config.maxTilesPerFrame);

    // Update active tiles map
    // Clear old buffer assignments
    for (const tile of this.activeTiles.values()) {
      tile.bufferIndex = -1;
    }
    this.activeTiles.clear();

    // Add selected tiles to active map
    for (const tile of selected) {
      this.activeTiles.set(tile.id, tile);
    }

    return selected;
  }

  /**
   * Accumulate scores from a query forecast.
   * Distributes the query count proportionally across overlapping tiles.
   */
  private accumulateScore(forecast: QueryForecast): void {
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
        const id = toDataTileId(gx, gy);
        const currentScore = this.tileScores.get(id) ?? 0;
        this.tileScores.set(id, currentScore + scorePerTile);
      }
    }
  }

  /**
   * Find tile containing a world point.
   * Returns null if no tile exists or tile is not active (no buffer assigned).
   */
  findTileForPoint(worldX: number, worldY: number): DataTile | null {
    const [gridX, gridY] = worldToTileGrid(
      worldX,
      worldY,
      this.config.tileSize,
    );
    const id = toDataTileId(gridX, gridY);
    const tile = this.activeTiles.get(id);

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
  getActiveTiles(): readonly DataTile[] {
    return Array.from(this.activeTiles.values());
  }

  /**
   * Get the tile configuration.
   */
  getConfig(): DataTileGridConfig {
    return this.config;
  }

  /**
   * Get the number of active tiles this frame.
   */
  getActiveTileCount(): number {
    return this.activeTiles.size;
  }

  /**
   * Clear all tiles and active state.
   */
  clear(): void {
    this.activeTiles.clear();
    this.tileScores.clear();
  }
}
