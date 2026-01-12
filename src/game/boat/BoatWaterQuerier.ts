/**
 * Single WaterQuerier for a boat and all its underwater components.
 * Forecasts all water queries for hull, keel, and rudder.
 */

import BaseEntity from "../../core/entity/BaseEntity";
import type { AABB } from "../../core/util/SparseSpatialHash";
import type { QueryForecast, WaterQuerier } from "../water/WaterQuerier";
import type { Boat } from "./Boat";

// Estimated query counts per component per tick
const HULL_QUERIES = 8; // ~8 edges, 1 query each
const KEEL_QUERIES = 4; // ~2 edges * 2 samples each
const RUDDER_QUERIES = 4; // 2 edges * 2 samples each
const TOTAL_QUERIES = HULL_QUERIES + KEEL_QUERIES + RUDDER_QUERIES; // ~16

// Margin around boat for query AABB (ft)
// Accounts for velocity and sampling outside the exact hull shape
const QUERY_MARGIN = 5;

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

  getQueryForecast(): QueryForecast | null {
    const hull = this.boat.hull;
    if (!hull?.body) return null;

    const pos = hull.body.position;
    const angle = hull.body.angle;

    // Get hull dimensions from config
    // Use approximate bounding box based on hull vertices
    // For a ~16ft boat, half-length ~8ft, half-width ~3.5ft
    const config = this.boat.config;
    const vertices = config.hull.vertices;

    // Compute local bounds from vertices
    let localMinX = Infinity,
      localMinY = Infinity;
    let localMaxX = -Infinity,
      localMaxY = -Infinity;

    for (const v of vertices) {
      localMinX = Math.min(localMinX, v[0]);
      localMinY = Math.min(localMinY, v[1]);
      localMaxX = Math.max(localMaxX, v[0]);
      localMaxY = Math.max(localMaxY, v[1]);
    }

    // Transform corners to world space and find AABB
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    const corners = [
      [localMinX, localMinY],
      [localMaxX, localMinY],
      [localMinX, localMaxY],
      [localMaxX, localMaxY],
    ];

    let minX = Infinity,
      minY = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity;

    for (const [lx, ly] of corners) {
      const wx = pos[0] + lx * cos - ly * sin;
      const wy = pos[1] + lx * sin + ly * cos;
      minX = Math.min(minX, wx);
      minY = Math.min(minY, wy);
      maxX = Math.max(maxX, wx);
      maxY = Math.max(maxY, wy);
    }

    // Add margin for velocity and sampling
    this.cachedAABB.minX = minX - QUERY_MARGIN;
    this.cachedAABB.minY = minY - QUERY_MARGIN;
    this.cachedAABB.maxX = maxX + QUERY_MARGIN;
    this.cachedAABB.maxY = maxY + QUERY_MARGIN;

    return {
      aabb: this.cachedAABB,
      queryCount: TOTAL_QUERIES,
    };
  }
}
