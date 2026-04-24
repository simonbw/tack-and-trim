import { on } from "../../../core/entity/handler";
import { profile } from "../../../core/util/Profiler";
import type { QueryTypeId } from "./query-worker-protocol";
import { STRIDE_PER_POINT } from "./query-worker-protocol";
import { QueryManager } from "./QueryManager";
import { QueryWorkerPool } from "./QueryWorkerPool";

/**
 * CPU-side query manager. Mirrors `GpuQueryManager` but dispatches work
 * to a shared worker pool over SharedArrayBuffers instead of the GPU.
 *
 * Lifecycle per tick:
 *   afterPhysicsStep: collect points, write them into the pool's points
 *     SAB for this manager's query type, then ask the pool to submit the
 *     frame (the pool coalesces submits across all CPU managers onto a
 *     single generation bump).
 *
 *   tick (next frame): if the pool reports the previous frame complete,
 *     read from the pool's results SAB and distribute to queries.
 *
 * One frame of latency, matching the GPU path, so physics consumers see
 * the same async behavior regardless of backend.
 */
export abstract class CpuQueryManager extends QueryManager {
  /**
   * When true, a `CpuQueryCoordinator` is driving the workerpool's
   * submit/await cycle. The coordinator batches all CPU managers'
   * submissions onto a single generation bump, which is essential —
   * otherwise each manager would race the others into the pool.
   */
  coordinated = false;

  /** Injected by owner (CpuQueryCoordinator or test setup). */
  protected pool: QueryWorkerPool | null = null;

  /** Results SAB view handed to `distributeResults` once a frame lands. */
  private resultsView: Float32Array | null = null;

  /**
   * Most recent point count we submitted to the pool — set in
   * afterPhysicsStep, consumed in tick.
   */
  private pendingPointCount = 0;

  /** True between submit and distribute. */
  private frameInFlight = false;

  abstract queryType: QueryTypeId;

  /**
   * Called by `CpuQueryCoordinator` on setup to hand over the shared
   * worker pool. Must be called before the first tick.
   */
  setPool(pool: QueryWorkerPool): void {
    this.pool = pool;
    const channel = pool.getChannel(this.queryType);
    this.resultsView = channel.results;
  }

  /**
   * Write per-frame uniforms (time, wind state, source weights, etc.)
   * into this channel's params SAB. Called by the coordinator before
   * the frame is submitted so the worker can read fresh values.
   */
  abstract writeParamsToSab(params: Float32Array): void;

  /**
   * Collect query points and write them into the shared pool's input
   * SAB for this manager's query type. Returns the point count so the
   * coordinator can assemble a single `submit()` across managers.
   */
  collectAndWritePoints(): number {
    if (!this.pool) return 0;

    const { points, pointCount } = this.collectPoints();
    if (pointCount === 0) {
      this.pendingPointCount = 0;
      return 0;
    }

    const channel = this.pool.getChannel(this.queryType);
    if (pointCount > channel.maxPoints) {
      console.warn(
        `[${this.constructor.name}] pointCount ${pointCount} exceeds channel max ${channel.maxPoints}; truncating.`,
      );
    }

    const floatCount = Math.min(
      pointCount * STRIDE_PER_POINT,
      channel.points.length,
    );
    // Copy into the SAB-backed Float32Array. `set` with a typed array
    // does the fast-path memmove.
    channel.points.set(points.subarray(0, floatCount));

    this.pendingPointCount = Math.min(pointCount, channel.maxPoints);
    return this.pendingPointCount;
  }

  /**
   * Mark this manager as having an in-flight frame. Called by the
   * coordinator after it submits the batched frame to the pool.
   */
  markFrameInFlight(): void {
    if (this.pendingPointCount === 0) {
      this.frameInFlight = false;
      return;
    }
    this.frameInFlight = true;
  }

  /**
   * If a submitted frame is ready, distribute its results to queries.
   */
  @on("tick")
  @profile
  onTick(): void {
    if (!this.frameInFlight) return;
    if (!this.pool || !this.resultsView) return;
    if (!this.pool.isFrameComplete()) return;

    this.distributeResults(this.resultsView);
    this.frameInFlight = false;
  }

  /**
   * Called by the coordinator before submit to populate this channel's
   * params SAB.
   */
  writeParamsForFrame(): void {
    if (!this.pool) return;
    const channel = this.pool.getChannel(this.queryType);
    this.writeParamsToSab(channel.params);
  }

  /**
   * Uncoordinated fallback: when no `CpuQueryCoordinator` is present,
   * each manager submits its own frame. This is a development/test
   * convenience — production should always use the coordinator so the
   * worker pool sees one generation bump per frame.
   */
  @on("afterPhysicsStep")
  @profile
  onAfterPhysicsStep(): void {
    if (this.coordinated) return;
    if (!this.pool) return;

    this.writeParamsForFrame();
    const pointCount = this.collectAndWritePoints();
    if (pointCount === 0) return;

    this.pool.submit([{ queryType: this.queryType, pointCount }]);
    this.frameInFlight = true;
  }
}
