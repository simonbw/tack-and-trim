/**
 * Interface for entities that query water data.
 * Entities with the "waterQuerier" tag should implement this interface.
 */

import type { QueryForecast } from "../datatiles/DataTileTypes";

/**
 * Interface for entities that query water data.
 * Entities with the "waterQuerier" tag should implement this interface.
 */
export interface WaterQuerier {
  getWaterQueryForecast(): QueryForecast | null;
}

/** Type guard for WaterQuerier interface. */
export function isWaterQuerier(value: unknown): value is WaterQuerier {
  return (
    typeof value === "object" &&
    value !== null &&
    "getWaterQueryForecast" in value
  );
}
