import { BaseEntity } from "../../../core/entity/BaseEntity";
import { on } from "../../../core/entity/handler";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import { DoubleBuffer } from "../../../core/util/DoubleBuffer";
import { profile, profileAsync } from "../../../core/util/Profiler";
import type { BaseQuery } from "./BaseQuery";

/**
 * Buffer layout configuration for a specific result type
 */
export interface ResultLayout {
  /** Number of floats per result */
  stride: number;
  /** Field names and their offsets within the stride */
  fields: Record<string, number>;
}

const STRIDE_PER_POINT = 2;

/**
 * Generic GPU-accelerated query manager
 *
 * Manages GPU buffers and computation for a specific query type.
 * Each concrete implementation handles one data source (terrain, water, wind).
 *
 * Features:
 * - Type-safe buffer management with named field layouts
 * - Double-buffered readback for non-blocking GPU data access
 * - Automatic query discovery via tags
 * - One-frame latency (results available next frame)
 *
 * @template TResult - The result type (e.g., WaterQueryResult)
 */
export abstract class QueryManager<TResult> extends BaseEntity {
  /**
   * GPU buffer containing input query points (vec2f per point).
   * Written by CPU, read by GPU compute shader.
   */
  private _pointBuffer: GPUBuffer | null = null;
  protected get pointBuffer(): GPUBuffer {
    if (!this._pointBuffer) {
      throw new Error(`${this.constructor.name}: pointBuffer not initialized`);
    }
    return this._pointBuffer;
  }
  protected set pointBuffer(value: GPUBuffer | null) {
    this._pointBuffer = value;
  }

  /**
   * GPU buffer containing computation results.
   * Written by GPU compute shader, copied to readback buffer for CPU access.
   * Cannot be directly read by CPU (STORAGE usage doesn't support mapping).
   */
  private _resultBuffer: GPUBuffer | null = null;
  protected get resultBuffer(): GPUBuffer {
    if (!this._resultBuffer) {
      throw new Error(`${this.constructor.name}: resultBuffer not initialized`);
    }
    return this._resultBuffer;
  }
  protected set resultBuffer(value: GPUBuffer | null) {
    this._resultBuffer = value;
  }

  /**
   * Double-buffered readback buffers for CPU access.
   * We copy resultBuffer to a readback buffer, then map it asynchronously.
   * While one readback buffer is mapped (waiting for GPU), we can copy new
   * results to the other buffer. This creates one frame of latency but
   * prevents blocking on GPU operations.
   */
  private _readbackBuffers: DoubleBuffer<GPUBuffer> | null = null;
  protected get readbackBuffers(): DoubleBuffer<GPUBuffer> {
    if (!this._readbackBuffers) {
      throw new Error(
        `${this.constructor.name}: readbackBuffers not initialized`,
      );
    }
    return this._readbackBuffers;
  }
  protected set readbackBuffers(value: DoubleBuffer<GPUBuffer> | null) {
    this._readbackBuffers = value;
  }

  /**
   * Promise for the currently pending mapAsync operation.
   * Resolves when GPU has finished copying and buffer is ready to read.
   */
  protected readbackPromise: Promise<void> | null = null;

  /**
   * Metadata for each query's position in the GPU buffer.
   * WeakMap ensures this data is private to QueryManager and auto-cleans up.
   */
  private queryBufferMetadata = new WeakMap<
    BaseQuery<TResult>,
    { offset: number; count: number }
  >();

  /**
   * Buffer layout for TResult
   * Example: { stride: 4, fields: { height: 0, normalX: 1, normalY: 2, terrainType: 3 } }
   */
  protected readonly resultLayout: ResultLayout;

  /** Maximum number of query points supported */
  protected readonly maxPoints: number;

  /** Size of the point buffer in bytes */
  get pointBufferSize(): number {
    return this.maxPoints * STRIDE_PER_POINT * Float32Array.BYTES_PER_ELEMENT;
  }

  /** Size of the result buffer in bytes */
  get resultBufferSize(): number {
    return (
      this.maxPoints * this.resultLayout.stride * Float32Array.BYTES_PER_ELEMENT
    );
  }

  constructor(resultLayout: ResultLayout, maxPoints: number) {
    super();
    this.resultLayout = resultLayout;
    this.maxPoints = maxPoints;
  }

  /**
   * Get all queries of this type from the game
   * Uses tags and type guards for type-safe collection
   */
  abstract getQueries(): BaseQuery<TResult>[];

  /**
   * Pack a TResult into a Float32Array at the given offset
   */
  abstract packResult(
    result: TResult,
    buffer: Float32Array,
    offset: number,
  ): void;

  /**
   * Unpack a TResult from a Float32Array at the given offset
   */
  abstract unpackResult(buffer: Float32Array, offset: number): TResult;

  /**
   * Dispatch GPU compute or generate stub data.
   * Override in subclasses to implement real GPU compute.
   */
  abstract dispatchCompute(pointCount: number): void;

  @on("add")
  onAdd(): void {
    const device = getWebGPU().device;

    // Initialize GPU buffers
    // Point buffer: vec2f per point
    this.pointBuffer = device.createBuffer({
      label: this.constructor.name + " Point Buffer",
      size: this.pointBufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Result buffer: layout.stride floats per result
    this.resultBuffer = device.createBuffer({
      label: this.constructor.name + " Result Buffer",
      size: this.resultBufferSize,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.COPY_DST,
    });

    // Readback buffers
    this.readbackBuffers = new DoubleBuffer(
      device.createBuffer({
        label: this.constructor.name + " Readback A",
        size: this.resultBufferSize,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      }),
      device.createBuffer({
        label: this.constructor.name + " Readback B",
        size: this.resultBufferSize,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      }),
    );
  }

  /**
   * Query pipeline with one-tick latency:
   *
   * Tick N onTick:
   *   1. Await GPU map operation from tick N-1
   *   2. Read and distribute results to queries
   *   3. Clear promise
   *
   * Tick N (entities use query results)
   *
   * Tick N afterPhysicsStep:
   *   1. Collect query points (based on updated entity positions)
   *   2. Upload to GPU and dispatch compute
   *   3. Copy results to readback buffer
   *   4. Start async map for next tick
   *
   * The double buffering allows us to swap buffers while one is mapped,
   * preventing GPU stalls.
   */
  @on("tick")
  @profileAsync
  async onTick() {
    // Wait for GPU results from previous tick and distribute them
    if (!this.readbackPromise) {
      return;
    }

    const readbackBuffer = this.readbackBuffers.getRead();
    let mappedSuccessfully = false;

    try {
      await this.readbackPromise;
      mappedSuccessfully = true;

      const data = new Float32Array(readbackBuffer.getMappedRange());
      const queries = this.getQueries();
      const layout = this.resultLayout;

      for (const query of queries) {
        const metadata = this.queryBufferMetadata.get(query);
        if (!metadata || metadata.offset < 0) continue; // query was either added this frame or had was skipped due to overflow

        const results: TResult[] = [];
        for (let i = 0; i < metadata.count; i++) {
          const pointIndex = metadata.offset + i;
          const offset = pointIndex * layout.stride;
          results.push(this.unpackResult(data, offset));
        }
        query.setResults(results);
      }
    } catch (error) {
      console.warn(
        `[${this.constructor.name}] Query readback failed (context loss?):`,
        (error as Error).message,
      );
    } finally {
      // Always unmap the buffer if mapping succeeded, even if processing failed
      if (mappedSuccessfully) {
        try {
          readbackBuffer.unmap();
        } catch {
          // Buffer might already be unmapped, ignore
        }
      }
      this.readbackPromise = null;
    }
  }

  @on("afterPhysicsStep")
  onAfterPhysicsStep(): void {
    const device = getWebGPU().device;

    // Collect query points based on updated entity positions
    const { points, queries } = this.collectPoints();
    const totalPoints = queries.reduce(
      (sum, q) => sum + (this.queryBufferMetadata.get(q)?.count ?? 0),
      0,
    );

    // Upload points to GPU
    device.queue.writeBuffer(
      this.pointBuffer,
      0,
      points.buffer,
      points.byteOffset,
      points.byteLength,
    );

    // Run GPU compute (or generate stub data)
    this.dispatchCompute(totalPoints);

    // Copy results to readback buffer for CPU access
    const readbackBuffer = this.readbackBuffers.getWrite();
    const commandEncoder = device.createCommandEncoder({
      label: `${this.constructor.name} Copy to Readback`,
    });

    commandEncoder.copyBufferToBuffer(
      this.resultBuffer,
      0,
      readbackBuffer,
      0,
      this.resultBufferSize,
    );

    device.queue.submit([commandEncoder.finish()]);

    // Start async map for next tick's results
    this.readbackBuffers.swap();
    this.readbackPromise = readbackBuffer.mapAsync(GPUMapMode.READ);
  }

  @profile
  protected collectPoints(): {
    points: Float32Array;
    queries: BaseQuery<TResult>[];
  } {
    const queries = this.getQueries();
    const points = new Float32Array(this.maxPoints * STRIDE_PER_POINT);
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

      // TEMPORARY: Removed validation to test if it's causing issues
      // // Validate all points before packing
      // let hasInvalidPoint = false;
      // for (const p of queryPoints) {
      //   if (!isFinite(p.x) || !isFinite(p.y)) {
      //     console.error(
      //       `${this.constructor.name}: Invalid query point (${p.x}, ${p.y}) - skipping entire query`,
      //     );
      //     hasInvalidPoint = true;
      //     break;
      //   }
      // }

      // if (hasInvalidPoint) {
      //   this.queryBufferMetadata.set(query, { offset: -1, count: 0 });
      //   continue;
      // }

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

    return { points, queries };
  }

  @on("destroy")
  onDestroy(): void {
    this.pointBuffer?.destroy();
    this.resultBuffer?.destroy();
    if (this.readbackBuffers) {
      this.readbackBuffers.getRead().destroy();
      this.readbackBuffers.getWrite().destroy();
    }
  }
}
