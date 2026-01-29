import { BaseEntity } from "../../../core/entity/BaseEntity";
import { on } from "../../../core/entity/handler";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import { DoubleBuffer } from "../../../core/util/DoubleBuffer";
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

const BYTES_PER_POINT = 2;

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
  protected mappedPromise: Promise<void> | null = null;

  /**
   * Flag indicating that mapped results are ready to be read.
   * Set to true when mapAsync completes, cleared after reading results.
   */
  protected hasMappedResults = false;

  /**
   * Buffer layout for TResult
   * Example: { stride: 4, fields: { height: 0, normalX: 1, normalY: 2, terrainType: 3 } }
   */
  protected readonly resultLayout: ResultLayout;

  /** Maximum number of query points supported */
  protected readonly maxPoints: number;

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

  get pointBufferSize(): number {
    return this.maxPoints * BYTES_PER_POINT * Float32Array.BYTES_PER_ELEMENT;
  }

  get resultBufferSize(): number {
    return (
      this.maxPoints * this.resultLayout.stride * Float32Array.BYTES_PER_ELEMENT
    );
  }

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
   * Tick N onTick (blocking):
   *   1. Wait for GPU results from tick N-1 to complete
   *   2. Read and distribute results to queries
   *
   * Tick N (entities use query results)
   *
   * Tick N afterPhysicsStep:
   *   1. Collect query points (based on updated entity positions)
   *   2. Upload to GPU and dispatch compute
   *   3. Copy results to readback buffer
   *   4. Start async map (completes before tick N+1)
   *
   * The double buffering allows us to start mapping one readback buffer while
   * copying new results to the other, preventing GPU stalls.
   */
  @on("tick")
  async onTick(_dt: number): Promise<void> {
    // Wait for GPU results from previous tick
    if (this.mappedPromise) {
      await this.mappedPromise;
    }

    // Read and distribute results if available
    if (this.hasMappedResults) {
      this.readAndDistributeResults();
      this.hasMappedResults = false;
      console.log(
        `${this.constructor.name}: Distributed results to ${this.getQueries().length} queries`,
      );
    }
  }

  @on("afterPhysicsStep")
  onAfterPhysicsStep(_dt: number): void {
    const device = getWebGPU().device;

    // Collect query points based on updated entity positions
    const { points, queries } = this.collectPoints();
    const totalPoints = queries.reduce((sum, q) => sum + q.bufferCount, 0);

    console.log(
      `${this.constructor.name}: Collected ${totalPoints} points from ${queries.length} queries`,
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
    const nextBuffer = this.readbackBuffers.getWrite();
    this.copyToReadback(nextBuffer);

    // Start async map for next tick's results (if no map is pending)
    if (!this.mappedPromise) {
      this.readbackBuffers.swap();
      this.mappedPromise = nextBuffer
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          this.hasMappedResults = true;
          this.mappedPromise = null;
        })
        .catch((err) => {
          console.error(`${this.constructor.name}: mapAsync failed:`, err);
          this.mappedPromise = null;
        });
    }
  }

  protected collectPoints(): {
    points: Float32Array;
    queries: BaseQuery<TResult>[];
  } {
    const queries = this.getQueries();
    const points = new Float32Array(this.maxPoints * 2);
    let currentPoint = 0;

    for (const query of queries) {
      const queryPoints = query.getQueryPoints();

      if (currentPoint + queryPoints.length > this.maxPoints) {
        console.warn(
          `${this.constructor.name}: Buffer overflow! Skipping ${queryPoints.length} points.`,
        );
        query.bufferOffset = -1;
        query.bufferCount = 0;
        continue;
      }

      query.bufferOffset = currentPoint;
      query.bufferCount = queryPoints.length;

      for (const p of queryPoints) {
        const offset = currentPoint * BYTES_PER_POINT;
        points[offset] = p.x;
        points[offset + 1] = p.y;
        currentPoint++;
      }
    }

    return { points, queries };
  }

  /**
   * Dispatch GPU compute or generate stub data.
   * Override in subclasses to implement real GPU compute.
   */
  protected dispatchCompute(pointCount: number): void {
    const device = getWebGPU().device;
    // Fake compute step - just write zeros
    const mockData = new Float32Array(
      pointCount * this.resultLayout.stride,
    ).fill(0);
    device.queue.writeBuffer(
      this.resultBuffer,
      0,
      mockData.buffer,
      mockData.byteOffset,
      mockData.byteLength,
    );
  }

  protected copyToReadback(readbackBuffer: GPUBuffer): void {
    if (!this.resultBuffer) return;
    const device = getWebGPU().device;

    const layout = this.resultLayout;
    const commandEncoder = device.createCommandEncoder({
      label: `${this.constructor.name} Copy to Readback`,
    });

    commandEncoder.copyBufferToBuffer(
      this.resultBuffer,
      0,
      readbackBuffer,
      0,
      this.maxPoints * layout.stride * Float32Array.BYTES_PER_ELEMENT,
    );

    device.queue.submit([commandEncoder.finish()]);
  }

  protected readAndDistributeResults(): void {
    if (!this.readbackBuffers) return;
    const buffer = this.readbackBuffers.getRead();

    const data = new Float32Array(buffer.getMappedRange());
    const queries = this.getQueries();
    const layout = this.resultLayout;

    for (const query of queries) {
      if (query.bufferOffset < 0) continue;

      const results: TResult[] = [];
      for (let i = 0; i < query.bufferCount; i++) {
        const pointIndex = query.bufferOffset + i;
        const offset = pointIndex * layout.stride;
        results.push(this.unpackResult(data, offset));
      }
      query.setResults(results);
    }

    buffer.unmap();
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
