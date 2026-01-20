/**
 * Single WaterQuerier for a boat and all its underwater components.
 * Forecasts all water queries for hull, keel, rudder, and spray.
 */

import BaseEntity from "../../core/entity/BaseEntity";
import type { AABB } from "../../core/util/SparseSpatialHash";
import type { QueryForecast } from "../world-data/datatiles/DataTileTypes";
import type { WaterQuerier } from "../world-data/water/WaterQuerier";
import type { Boat } from "./Boat";

// Margin around hull AABB for query forecast (ft)
const QUERY_MARGIN = 2;

/**
 * WaterQuerier that forecasts water queries for an entire boat.
 */
export class BoatWaterQuerier extends BaseEntity implements WaterQuerier {
  tags = ["waterQuerier"];

  // Reusable AABB to avoid allocations
  private cachedAABB: AABB = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  constructor(private boat: Boat) {
    super();
  }

  getWaterQueryForecast(): QueryForecast | null {
    const hull = this.boat.hull;
    if (!hull?.body) return null;

    // Get AABB directly from physics body
    const bodyAABB = hull.body.getAABB();

    // Add margin
    this.cachedAABB.minX = bodyAABB.lowerBound[0] - QUERY_MARGIN;
    this.cachedAABB.minY = bodyAABB.lowerBound[1] - QUERY_MARGIN;
    this.cachedAABB.maxX = bodyAABB.upperBound[0] + QUERY_MARGIN;
    this.cachedAABB.maxY = bodyAABB.upperBound[1] + QUERY_MARGIN;

    // Query count: hull skin friction (1) + keel (4) + rudder (4) + spray (1 per vertex)
    const sprayQueries = this.boat.config.hull.vertices.length;
    const queryCount = 1 + 4 + 4 + sprayQueries;

    return {
      aabb: this.cachedAABB,
      queryCount,
    };
  }
}
