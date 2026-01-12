/**
 * Interface for entities that query water state.
 *
 * Entities implementing this interface allow the tile system to prioritize
 * GPU computation for regions where physics queries will occur.
 */

import type { AABB } from "../../core/util/SparseSpatialHash";

/**
 * Forecast of water queries an entity will make this frame.
 */
export interface QueryForecast {
  /** Bounding box in world coordinates where queries will occur */
  aabb: Readonly<AABB>;
  /** Expected number of queries this frame (used for tile scoring) */
  queryCount: number;
}

/**
 * Interface for entities that query water state.
 * Implementing this allows the tile system to prioritize GPU computation
 * for regions where physics queries will occur.
 */
export interface WaterQuerier {
  /**
   * Forecast queries for the next frame.
   * Called during tile selection phase (before GPU compute).
   * Return null if no queries are expected this frame.
   */
  getQueryForecast(): QueryForecast | null;
}

/**
 * Type guard for WaterQuerier interface.
 */
export function isWaterQuerier(entity: unknown): entity is WaterQuerier {
  return (
    typeof entity === "object" &&
    entity !== null &&
    "getQueryForecast" in entity &&
    typeof (entity as WaterQuerier).getQueryForecast === "function"
  );
}
