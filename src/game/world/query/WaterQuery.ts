import { BaseEntity } from "../../../core/entity/BaseEntity";
import { V2d } from "../../../core/Vector";

/**
 * Result data from a water query at a specific point
 */
export interface WaterQueryResult {
  /** Surface height at this point (world Y coordinate) */
  surfaceHeight: number;
  /** Water velocity (m/s) */
  velocity: V2d;
  /** Surface normal vector (points up from water) */
  normal: V2d;
  /** Water depth at this point (meters, undefined if unknown) */
  depth: number | undefined;
}

/**
 * Entity that queries water data at multiple points each frame.
 * Stub implementation - returns empty results until real system is implemented.
 */
export class WaterQuery extends BaseEntity {
  /** Query points for this frame */
  public points: V2d[] = [];

  /** Results corresponding to each point (same length as points array) */
  public results: WaterQueryResult[] = [];

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
  getResultForPoint(point: V2d): WaterQueryResult | undefined {
    return undefined;
  }

  /**
   * Iterate over [point, result] pairs
   */
  *[Symbol.iterator](): Iterator<[V2d, WaterQueryResult]> {
    // Stub: return empty iterator
  }

  /**
   * Convenience method: query once and destroy
   */
  async getResultAndDestroy(): Promise<WaterQueryResult[]> {
    return [];
  }
}
