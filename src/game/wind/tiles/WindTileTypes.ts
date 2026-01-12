/**
 * Types and utilities for the tile-based wind computation system.
 * Mirrors the water tile system but with wind-specific configuration.
 */

import type { AABB } from "../../../core/util/SparseSpatialHash";

/**
 * Unique identifier for a tile based on grid coordinates.
 * Format: "x,y" where x and y are tile grid indices.
 */
export type WindTileId = `${number},${number}`;

/**
 * Configuration for the wind tile grid system.
 */
export interface WindTileGridConfig {
  /** Size of each tile in world units (feet) */
  tileSize: number;
  /** Resolution of each tile texture (pixels per side) */
  tileResolution: number;
  /** Maximum number of tiles to compute per frame */
  maxTilesPerFrame: number;
  /** Minimum score threshold for tile computation */
  minScoreThreshold: number;
}

/**
 * Default configuration for the wind tile grid.
 * - 64 ft tiles: matches water system
 * - 256 px resolution: 4 px/ft (double water) for fine-grained sail queries
 * - 64 tiles max per frame: same as water
 * - Score threshold 1: at least 1 expected query
 */
export const DEFAULT_WIND_TILE_CONFIG: WindTileGridConfig = {
  tileSize: 64,
  tileResolution: 256,
  maxTilesPerFrame: 64,
  minScoreThreshold: 1,
};

/**
 * Represents a single tile in the wind grid.
 */
export interface WindTile {
  /** Unique tile identifier */
  id: WindTileId;
  /** Grid X coordinate */
  gridX: number;
  /** Grid Y coordinate */
  gridY: number;
  /** World-space bounds */
  bounds: AABB;
  /** Current score based on query demand */
  score: number;
  /** Time when this tile was last computed */
  lastComputedTime: number;
  /** Index in the readback buffer pool (-1 if not assigned) */
  bufferIndex: number;
}

/**
 * Convert grid coordinates to WindTileId.
 */
export function toWindTileId(gridX: number, gridY: number): WindTileId {
  return `${gridX},${gridY}`;
}

/**
 * Convert world coordinates to grid coordinates.
 */
export function worldToWindGrid(
  worldX: number,
  worldY: number,
  tileSize: number,
): [number, number] {
  return [Math.floor(worldX / tileSize), Math.floor(worldY / tileSize)];
}

/**
 * Get the world-space AABB for a tile at given grid coordinates.
 */
export function getWindTileBounds(
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
