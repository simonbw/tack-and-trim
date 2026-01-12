/**
 * Types and utilities for the tile-based water computation system.
 */

import type { AABB } from "../../../core/util/SparseSpatialHash";

/**
 * Unique identifier for a tile based on grid coordinates.
 * Format: "x,y" where x and y are tile grid indices.
 */
export type TileId = `${number},${number}`;

/**
 * Configuration for the tile grid system.
 */
export interface TileGridConfig {
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
 * Default configuration for the tile grid.
 * - 64 ft tiles: good balance of precision vs tile count
 * - 128 px resolution: 2 px/ft matches MIN_PHYSICS_RESOLUTION
 * - 4 tiles max: limits GPU work per frame
 * - Score threshold 1: at least 1 expected query
 */
export const DEFAULT_TILE_CONFIG: TileGridConfig = {
  tileSize: 64,
  tileResolution: 128,
  maxTilesPerFrame: 16,
  minScoreThreshold: 1,
};

/**
 * Represents a single tile in the grid.
 */
export interface Tile {
  /** Unique tile identifier */
  id: TileId;
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
 * Convert grid coordinates to TileId.
 */
export function toTileId(gridX: number, gridY: number): TileId {
  return `${gridX},${gridY}`;
}

/**
 * Convert world coordinates to grid coordinates.
 */
export function worldToGrid(
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
