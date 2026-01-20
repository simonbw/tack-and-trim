/**
 * Interface for entities that query wind data.
 * Entities with the "windQuerier" tag should implement this interface.
 */

import type { QueryForecast } from "../datatiles/DataTileTypes";

/**
 * Interface for entities that query wind data.
 * Entities with the "windQuerier" tag should implement this interface.
 */
export interface WindQuerier {
  getWindQueryForecast(): QueryForecast | null;
}

/** Type guard for WindQuerier interface. */
export function isWindQuerier(value: unknown): value is WindQuerier {
  return (
    typeof value === "object" &&
    value !== null &&
    "getWindQueryForecast" in value
  );
}
