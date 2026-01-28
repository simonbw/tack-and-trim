/**
 * Terrain querier interface (stub for compilation).
 * TODO (Phase 2+): Implement actual terrain query system.
 */

import type { QueryForecast } from "../datatiles/DataTileTypes";

/**
 * Interface for entities that query terrain data.
 * Allows the terrain system to preload data tiles efficiently.
 */
export interface TerrainQuerier {
  /**
   * Get forecast of terrain queries this entity will make.
   * Used to preload terrain data tiles before they're needed.
   */
  getTerrainQueryForecast(): QueryForecast | null;
}
