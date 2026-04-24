import { BaseEntity } from "../../../core/entity/BaseEntity";
import { profile } from "../../../core/util/Profiler";
import type { BaseQuery } from "./BaseQuery";
import { STRIDE_PER_POINT } from "./query-worker-protocol";

export { STRIDE_PER_POINT };

/**
 * Buffer layout configuration for a specific result type
 */
export interface ResultLayout {
  /** Number of floats per result */
  stride: number;
  /** Field names and their offsets within the stride */
  fields: Record<string, number>;
}

/**
 * Query manager base class shared by all backends (GPU, CPU worker, etc).
 *
 * Contains the backend-independent orchestration: query discovery, point
 * collection into a flat packed array, and result distribution via
 * zero-copy `Float32Array` views on a shared data buffer.
 *
 * Backend-specific concerns (dispatch, readback, synchronization) live in
 * subclasses such as `GpuQueryManager`.
 */
export abstract class QueryManager extends BaseEntity {
  tags = ["queryManager"];

  /**
   * Reusable Float32Array for collecting query points. Avoids allocating
   * a new array every frame. One entry pair (x, y) per point.
   */
  private pointsArray: Float32Array | null = null;

  /**
   * Metadata for each query's position in the collected point buffer.
   * WeakMap ensures this data is private to QueryManager and auto-cleans
   * up when queries are destroyed.
   */
  private queryBufferMetadata = new WeakMap<
    BaseQuery<unknown>,
    { offset: number; count: number }
  >();

  /**
   * Buffer layout for results. Example:
   * `{ stride: 4, fields: { height: 0, normalX: 1, normalY: 2, terrainType: 3 } }`
   */
  protected readonly resultLayout: ResultLayout;

  /** Maximum number of query points supported per frame. */
  protected readonly maxPoints: number;

  constructor(resultLayout: ResultLayout, maxPoints: number) {
    super();
    this.resultLayout = resultLayout;
    this.maxPoints = maxPoints;
  }

  /**
   * Get all queries of this type from the game.
   */
  abstract getQueries(): BaseQuery<unknown>[];

  /**
   * Walk all queries and pack their requested points into a flat
   * `Float32Array`. Records each query's offset + count for later result
   * distribution. Reuses the internal buffer across calls.
   */
  @profile
  protected collectPoints(): {
    points: Float32Array;
    queries: BaseQuery<unknown>[];
    pointCount: number;
  } {
    const queries = this.getQueries();

    if (
      !this.pointsArray ||
      this.pointsArray.length < this.maxPoints * STRIDE_PER_POINT
    ) {
      this.pointsArray = new Float32Array(this.maxPoints * STRIDE_PER_POINT);
    }
    const points = this.pointsArray;
    let currentPoint = 0;

    for (const query of queries) {
      const queryPoints = query.getQueryPoints();

      if (currentPoint + queryPoints.length > this.maxPoints) {
        console.warn(
          `${this.constructor.name}: Buffer overflow! Skipping query with ${queryPoints.length} points.`,
        );
        this.queryBufferMetadata.set(query, { offset: -1, count: 0 });
        continue;
      }

      this.queryBufferMetadata.set(query, {
        offset: currentPoint,
        count: queryPoints.length,
      });

      for (const p of queryPoints) {
        const offset = currentPoint * STRIDE_PER_POINT;
        points[offset] = p.x;
        points[offset + 1] = p.y;
        currentPoint++;
      }
    }

    return { points, queries, pointCount: currentPoint };
  }

  /**
   * Hand each query a zero-copy `Float32Array` view into the shared
   * result buffer using the metadata captured by `collectPoints`.
   */
  protected distributeResults(dataBuffer: Float32Array): void {
    const queries = this.getQueries();
    const stride = this.resultLayout.stride;
    for (const query of queries) {
      const metadata = this.queryBufferMetadata.get(query);
      if (!metadata || metadata.offset < 0) continue;
      query.receiveData(dataBuffer, metadata.offset * stride, metadata.count);
    }
  }
}
