import { BaseEntity } from "../../../core/entity/BaseEntity";
import { V2d } from "../../../core/Vector";

/**
 * Result data from a terrain query at a specific point
 */
export interface TerrainQueryResult {
  /** Terrain height at this point (world Y coordinate) */
  height: number;
  /** Surface normal vector (points up from terrain) */
  normal: V2d;
  /** Terrain type identifier */
  terrainType: string;
}

/**
 * Entity that queries terrain data at multiple points each frame.
 * Stub implementation - returns empty results until real system is implemented.
 */
export class TerrainQuery extends BaseEntity {
  /** Query points for this frame */
  public points: V2d[] = [];

  /** Results corresponding to each point (same length as points array) */
  public results: TerrainQueryResult[] = [];

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
  getResultForPoint(point: V2d): TerrainQueryResult | undefined {
    return undefined;
  }

  /**
   * Iterate over [point, result] pairs
   */
  *[Symbol.iterator](): Iterator<[V2d, TerrainQueryResult]> {
    // Stub: return empty iterator
  }

  /**
   * Convenience method: query once and destroy
   */
  async getResultAndDestroy(): Promise<TerrainQueryResult[]> {
    return [];
  }
}
