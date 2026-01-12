/**
 * Interface for entities that query wind state.
 *
 * Entities implementing this interface allow the tile system to prioritize
 * GPU computation for regions where wind queries will occur.
 */

import type { AABB } from "../../core/util/SparseSpatialHash";

/**
 * Forecast of wind queries an entity will make this frame.
 */
export interface WindQueryForecast {
  /** Bounding box in world coordinates where queries will occur */
  aabb: Readonly<AABB>;
  /** Expected number of queries this frame (used for tile scoring) */
  queryCount: number;
}

/**
 * Interface for entities that query wind state.
 * Implementing this allows the tile system to prioritize GPU computation
 * for regions where wind physics queries will occur.
 */
export interface WindQuerier {
  /**
   * Forecast queries for the next frame.
   * Called during tile selection phase (before GPU compute).
   * Return null if no queries are expected this frame.
   */
  getWindQueryForecast(): WindQueryForecast | null;
}

/**
 * Type guard for WindQuerier interface.
 */
export function isWindQuerier(entity: unknown): entity is WindQuerier {
  return (
    typeof entity === "object" &&
    entity !== null &&
    "getWindQueryForecast" in entity &&
    typeof (entity as WindQuerier).getWindQueryForecast === "function"
  );
}
