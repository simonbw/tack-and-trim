/**
 * Interface for entities that query terrain data.
 * Entities with the "terrainQuerier" tag should implement this interface.
 */

import type { QueryForecast } from "../datatiles/DataTileTypes";

/**
 * Interface for entities that query terrain data.
 * Entities with the "terrainQuerier" tag should implement this interface.
 */
export interface TerrainQuerier {
  getTerrainQueryForecast(): QueryForecast | null;
}

/** Type guard for TerrainQuerier interface. */
export function isTerrainQuerier(value: unknown): value is TerrainQuerier {
  return (
    typeof value === "object" &&
    value !== null &&
    "getTerrainQueryForecast" in value
  );
}
