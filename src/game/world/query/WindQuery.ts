import { BaseEntity } from "../../../core/entity/BaseEntity";
import { V2d } from "../../../core/Vector";

/**
 * Result data from a wind query at a specific point
 */
export interface WindQueryResult {
  /** Wind velocity vector (m/s) */
  velocity: V2d;
  /** Wind speed (m/s, derived from velocity) */
  speed: number;
  /** Wind direction in radians (derived from velocity) */
  direction: number;
}

/**
 * Entity that queries wind data at multiple points each frame.
 * Stub implementation - returns empty results until real system is implemented.
 */
export class WindQuery extends BaseEntity {
  /** Query points for this frame */
  public points: V2d[] = [];

  /** Results corresponding to each point (same length as points array) */
  public results: WindQueryResult[] = [];

  /**
   * @param getPoints Callback that returns the points to query this frame
   */
  constructor(private getPoints: () => V2d[]) {
    super();
  }

  /**
   * Get the result for a specific point (by reference equality)
   * Returns undefined if point not found in query
   */
  getResultForPoint(point: V2d): WindQueryResult | undefined {
    return undefined;
  }

  /**
   * Iterate over [point, result] pairs
   */
  *[Symbol.iterator](): Iterator<[V2d, WindQueryResult]> {
    // Stub: return empty iterator
  }

  /**
   * Convenience method: query once and destroy
   */
  async getResultAndDestroy(): Promise<WindQueryResult[]> {
    return [];
  }
}
