/**
 * Shared types for data tile-based GPU computation systems.
 *
 * This module provides the core abstractions for:
 * - Data tile grid configuration and management
 * - World-space to tile-space coordinate mapping
 * - Query forecasting for demand-based tile scheduling
 * - GPU readback viewport tracking
 */

import type { AABB } from "../../core/util/SparseSpatialHash";

/**
 * Unique identifier for a data tile based on grid coordinates.
 * Format: "x,y" where x and y are tile grid indices.
 */
export type DataTileId = `${number},${number}`;

/**
 * Configuration for a data tile grid system.
 */
export interface DataTileGridConfig {
  /** Size of each tile in world units */
  tileSize: number;
  /** Resolution of each tile texture (pixels per side) */
  tileResolution: number;
  /** Maximum number of tiles to compute per frame */
  maxTilesPerFrame: number;
  /** Minimum score threshold for tile computation */
  minScoreThreshold: number;
}

/**
 * A data tile in the grid.
 */
export interface DataTile {
  /** Unique tile identifier */
  id: DataTileId;
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
 * Viewport bounds for GPU computation readback.
 */
export interface ReadbackViewport {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Time value used for this computation */
  time: number;
}

/**
 * Forecast of queries an entity will make this frame.
 * Used for demand-based tile scheduling.
 */
export interface QueryForecast {
  /** Bounding box in world coordinates where queries will occur */
  aabb: Readonly<AABB>;
  /** Expected number of queries this frame (used for tile scoring) */
  queryCount: number;
}

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
