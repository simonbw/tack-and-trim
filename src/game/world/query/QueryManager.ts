import { BaseEntity } from "../../../core/entity/BaseEntity";
import { on } from "../../../core/entity/handler";

import { DoubleBuffer } from "../../../core/util/DoubleBuffer";
import { profile, profileAsync, profiler } from "../../../core/util/Profiler";
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
 * GPU-accelerated query manager base class.
 *
 * Manages GPU buffers and computation for a specific query type.
 * Each concrete implementation handles one data source (terrain, water, wind).
 *
 * Features:
 * - Type-safe buffer management with named field layouts
 * - Double-buffered readback for non-blocking GPU data access
 * - Automatic query discovery via tags
 * - One-frame latency (results available next frame)
 * - Zero-allocation result delivery via buffer-backed views
 */
export abstract class QueryManager extends BaseEntity {
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
   * Number of bytes in the pending readback operation.
   * Used for partial buffer mapping to avoid slow paths for large buffers.
   */
  private pendingReadbackBytes: number = 0;

  /**
   * Reusable Float32Array for collecting query points.
   * Avoids allocating a new array every frame.
   */
  private pointsArray: Float32Array | null = null;

  /**
   * Persistent CPU-side buffer for result data.
   * Mapped GPU data is copied here immediately, then the GPU buffer is unmapped.
   * Query views reference slices of this buffer.
   */
  private dataBuffer: Float32Array | null = null;

  /**
   * Metadata for each query's position in the GPU buffer.
   * WeakMap ensures this data is private to QueryManager and auto-cleans up.
   */
  private queryBufferMetadata = new WeakMap<
    BaseQuery<unknown>,
    { offset: number; count: number }
  >();

  /**
   * Buffer layout for results.
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
   * Get all queries of this type from the game.
   */
  abstract getQueries(): BaseQuery<unknown>[];

  /**
   * Dispatch GPU compute shader.
   *
   * @param pointCount Number of points to process
   * @param commandEncoder Command encoder to record compute pass to (caller will submit)
   */
  abstract dispatchCompute(
    pointCount: number,
    commandEncoder: GPUCommandEncoder,
  ): void;

  @on("add")
  onAdd(): void {
    const device = this.game.getWebGPUDevice();

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
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
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
   *   2. Copy mapped data to persistent CPU buffer, unmap immediately
   *   3. Distribute buffer slices to queries (zero-copy views)
   *
   * Tick N (entities use query results via buffer-backed views)
   *
   * Tick N afterPhysicsStep:
   *   1. Collect query points (based on updated entity positions)
   *   2. Upload to GPU and dispatch compute
   *   3. Copy results to readback buffer
   *   4. Start async map for next tick
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
    const prefix = this.constructor.name;

    try {
      const awaitStart = performance.now();
      await this.readbackPromise;
      profiler.recordElapsed(
        `${prefix}.awaitMapAsync`,
        performance.now() - awaitStart,
      );
      mappedSuccessfully = true;

      // Create temporary view over mapped GPU memory
      const mappedView = new Float32Array(
        readbackBuffer.getMappedRange(0, this.pendingReadbackBytes),
      );

      // Copy to persistent CPU buffer
      const floatCount =
        this.pendingReadbackBytes / Float32Array.BYTES_PER_ELEMENT;
      if (!this.dataBuffer || this.dataBuffer.length < floatCount) {
        this.dataBuffer = new Float32Array(
          this.maxPoints * this.resultLayout.stride,
        );
      }
      this.dataBuffer.set(mappedView);

      // Unmap ASAP to free GPU buffer for next frame's copy
      readbackBuffer.unmap();
      mappedSuccessfully = false; // Already unmapped, skip finally unmap

      // Distribute results to queries via zero-copy Float32Array views
      const queries = this.getQueries();
      const stride = this.resultLayout.stride;
      for (const query of queries) {
        const metadata = this.queryBufferMetadata.get(query);
        if (!metadata || metadata.offset < 0) continue;
        query.receiveData(
          this.dataBuffer,
          metadata.offset * stride,
          metadata.count,
        );
      }
    } catch (error) {
      console.warn(
        `[${this.constructor.name}] Query readback failed (context loss?):`,
        (error as Error).message,
      );
    } finally {
      // Unmap if mapping succeeded but we didn't get to the unmap above
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
  @profile
  onAfterPhysicsStep(): void {
    const device = this.game.getWebGPUDevice();

    // Collect query points based on updated entity positions
    const { points, pointCount } = this.collectPoints();

    // Skip GPU work entirely if there are no query points
    if (pointCount === 0) {
      return;
    }

    // Upload only the points we actually have
    const pointBytesNeeded =
      pointCount * STRIDE_PER_POINT * Float32Array.BYTES_PER_ELEMENT;
    device.queue.writeBuffer(
      this.pointBuffer,
      0,
      points.buffer,
      points.byteOffset,
      pointBytesNeeded,
    );

    // Single command encoder for both compute and copy
    const commandEncoder = device.createCommandEncoder({
      label: `${this.constructor.name} Compute + Copy`,
    });

    // Run GPU compute (records to command encoder)
    this.dispatchCompute(pointCount, commandEncoder);

    // Copy results to readback buffer
    const resultBytesNeeded =
      pointCount * this.resultLayout.stride * Float32Array.BYTES_PER_ELEMENT;
    const readbackBuffer = this.readbackBuffers.getWrite();

    commandEncoder.copyBufferToBuffer(
      this.resultBuffer,
      0,
      readbackBuffer,
      0,
      resultBytesNeeded,
    );

    // Single submit for compute + copy
    device.queue.submit([commandEncoder.finish()]);

    // Start async map for next tick's results
    // Use partial mapping to avoid slow path for large buffers (>~125KB threshold)
    this.readbackBuffers.swap();
    this.pendingReadbackBytes = resultBytesNeeded;
    this.readbackPromise = readbackBuffer.mapAsync(
      GPUMapMode.READ,
      0,
      resultBytesNeeded,
    );
  }

  @profile
  protected collectPoints(): {
    points: Float32Array;
    queries: BaseQuery<unknown>[];
    pointCount: number;
  } {
    const queries = this.getQueries();

    // Reuse or create points array
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
