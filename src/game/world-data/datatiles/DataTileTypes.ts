/**
 * Data tile types (stub for compilation).
 * TODO (Phase 2+): Implement actual data tile system.
 */

import type { AABB } from "../../../core/util/SparseSpatialHash";

/**
 * Query forecast for requesting data tiles.
 */
export interface QueryForecast {
  /** Axis-aligned bounding box for the query */
  aabb: AABB;
  /** Expected number of queries within this region */
  queryCount: number;
}
