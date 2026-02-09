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
 * - Zero-allocation result access via buffer-backed view objects
 * - Automatic discovery via tags (no manual registration needed)
 *
 * @template TView - The result view type for this query (e.g., WaterResultView)
 */
export abstract class BaseQuery<TView> extends BaseEntity {
  private getPointsCallback: () => ReadonlyArray<V2d>;

  // Double-buffered: points that match current results
  private _points: ReadonlyArray<V2d> = [];

  // Points submitted for next frame's results
  private _pendingPoints: ReadonlyArray<V2d> | undefined;

  /**
   * Float32Array view into the QueryManager's shared data buffer.
   * Contains only this query's result data, starting at offset 0.
   * Updated each frame by QueryManager.
   * @internal
   */
  _data: Float32Array = new Float32Array(0);

  private _resultCount: number = 0;

  // Cached results array for backward compatibility with .results accessor
  private _resultsCache: TView[] | null = null;
  private _resultsCacheCount: number = -1;

  /** Number of floats per result entry. Defined by each query type. */
  abstract readonly stride: number;

  constructor(getPoints: () => ReadonlyArray<V2d>) {
    super();
    this.getPointsCallback = getPoints;
  }

  /**
   * Get a result view at the given index. Zero-allocation after warmup.
   * The view reads directly from the GPU result buffer.
   */
  abstract get(index: number): TView;

  /** Number of results currently available. */
  get length(): number {
    return this._resultCount;
  }

  /**
   * Get results as an array (backward compatibility).
   * Prefer using get(i) + length for hot paths.
   */
  get results(): readonly TView[] {
    if (!this._resultsCache || this._resultsCacheCount !== this._resultCount) {
      if (!this._resultsCache) {
        this._resultsCache = [];
      }
      this._resultsCache.length = this._resultCount;
      for (let i = 0; i < this._resultCount; i++) {
        this._resultsCache[i] = this.get(i);
      }
      this._resultsCacheCount = this._resultCount;
    }
    return this._resultsCache;
  }

  /**
   * Get the current query points (synchronized with results).
   */
  get points(): ReadonlyArray<V2d> {
    return this._points;
  }

  /**
   * Get the result for a specific point.
   *
   * @param point The query point to look up
   * @returns The result for that point, or undefined if not found
   */
  getResultForPoint(point: V2d): TView | undefined {
    const index = this._points.findIndex((p) => p.equals(point));
    return index >= 0 ? this.get(index) : undefined;
  }

  /**
   * Iterator support for iterating over (point, result) pairs.
   *
   * @example
   * for (const [point, result] of query) {
   *   console.log(`Point ${point} has result ${result}`);
   * }
   */
  *[Symbol.iterator](): Iterator<[V2d, TView]> {
    for (let i = 0; i < this._resultCount; i++) {
      yield [this._points[i], this.get(i)];
    }
  }

  /**
   * Wait for results and then destroy the query.
   *
   * Useful for one-shot queries:
   * @example
   * const results = await new TerrainQuery(() => [V(0, 0)]).getResultAndDestroy();
   */
  async getResultAndDestroy(): Promise<TView[]> {
    // Wait one frame for results to be computed
    await new Promise((resolve) => setTimeout(resolve, 16));
    const results: TView[] = [];
    for (let i = 0; i < this._resultCount; i++) {
      results.push(this.get(i));
    }
    this.destroy();
    return results;
  }

  /**
   * Internal method called by QueryManager to collect points.
   * Stores points in pending buffer - they'll become active when results arrive.
   * @internal
   */
  getQueryPoints(): ReadonlyArray<V2d> {
    this._pendingPoints = this.getPointsCallback();
    return this._pendingPoints;
  }

  /**
   * Internal method called by QueryManager to deliver result data.
   * Creates a zero-copy Float32Array view into the manager's shared buffer.
   * @internal
   */
  receiveData(
    managerBuffer: Float32Array,
    floatOffset: number,
    count: number,
  ): void {
    // Create a zero-copy view into the manager's buffer for this query's slice
    const floatLength = count * this.stride;
    this._data = new Float32Array(
      managerBuffer.buffer,
      managerBuffer.byteOffset + floatOffset * Float32Array.BYTES_PER_ELEMENT,
      floatLength,
    );

    this._resultCount = count;
    this._resultsCacheCount = -1; // invalidate results cache

    // Swap pending points into active
    this._points = this._pendingPoints!;
    this._pendingPoints = undefined;
  }
}
