import { BaseEntity } from "../../../core/entity/BaseEntity";
import type { V2d } from "../../../core/Vector";

/**
 * Abstract base class for world queries.
 *
 * Queries provide a declarative API for sampling world data (terrain, water, wind)
 * at arbitrary points. The QueryManager handles the GPU infrastructure.
 *
 * Features:
 * - Dynamic point collection via callback
 * - Iterator support for iterating over (point, result) pairs
 * - Result lookup by point
 * - Automatic discovery via tags (no manual registration needed)
 *
 * @template TResult - The result type for this query
 */
export abstract class BaseQuery<TResult> extends BaseEntity {
  private getPointsCallback: () => V2d[];
  private _points: V2d[] = [];
  private _results: TResult[] = [];

  // Internal state used by QueryManager
  /** @internal Buffer offset for this query's points */
  bufferOffset: number = -1;
  /** @internal Number of points in the buffer for this query */
  bufferCount: number = 0;

  constructor(getPoints: () => V2d[]) {
    super();
    this.getPointsCallback = getPoints;
  }

  /**
   * Get the current query points (read-only).
   */
  get points(): readonly V2d[] {
    return this._points;
  }

  /**
   * Get the current results (read-only).
   */
  get results(): readonly TResult[] {
    return this._results;
  }

  /**
   * Get the result for a specific point.
   *
   * @param point The query point to look up
   * @returns The result for that point, or undefined if not found
   */
  getResultForPoint(point: V2d): TResult | undefined {
    const index = this._points.findIndex((p) => p.equals(point));
    return index >= 0 ? this._results[index] : undefined;
  }

  /**
   * Iterator support for iterating over (point, result) pairs.
   *
   * @example
   * for (const [point, result] of query) {
   *   console.log(`Point ${point} has result ${result}`);
   * }
   */
  *[Symbol.iterator](): Iterator<[V2d, TResult]> {
    for (let i = 0; i < this._points.length; i++) {
      yield [this._points[i], this._results[i]];
    }
  }

  /**
   * Wait for results and then destroy the query.
   *
   * Useful for one-shot queries:
   * @example
   * const results = await new TerrainQuery(() => [V(0, 0)]).getResultAndDestroy();
   */
  async getResultAndDestroy(): Promise<TResult[]> {
    // Wait one frame for results to be computed
    await new Promise((resolve) => setTimeout(resolve, 16));
    const results = [...this._results];
    this.game.removeEntity(this);
    return results;
  }

  /**
   * Internal method called by QueryManager to collect points.
   * @internal
   */
  getQueryPoints(): V2d[] {
    this._points = this.getPointsCallback();
    return this._points;
  }

  /**
   * Internal method called by QueryManager to set results.
   * @internal
   */
  setResults(results: TResult[]): void {
    this._results = results;
  }
}
