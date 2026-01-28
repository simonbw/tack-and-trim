/**
 * Water querier interface (stub for compilation).
 * TODO (Phase 2+): Implement actual water query system.
 */

import type { QueryForecast } from "../datatiles/DataTileTypes";

/**
 * Interface for entities that query water data.
 * Allows the water system to preload data tiles efficiently.
 */
export interface WaterQuerier {
  /**
   * Get forecast of water queries this entity will make.
   * Used to preload water data tiles before they're needed.
   */
  getWaterQueryForecast(): QueryForecast | null;
}
