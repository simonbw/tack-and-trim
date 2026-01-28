import { BaseEntity } from "../../../core/entity/BaseEntity";
import { on } from "../../../core/entity/handler";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
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

/**
 * Generic GPU-accelerated query manager
 *
 * Manages GPU buffers and computation for a specific query type.
 * Each concrete implementation handles one data source (terrain, water, wind).
 *
 * Features:
 * - Type-safe buffer management with named field layouts
 * - Double-buffered staging for non-blocking GPU readback
 * - Automatic query discovery via tags
 * - One-frame latency (results available next frame)
 *
 * @template TResult - The result type (e.g., WaterQueryResult)
 */
export abstract class QueryManager<TResult> extends BaseEntity {
  protected maxPoints = 8192;

  // GPU buffers
  protected pointBuffer: GPUBuffer | null = null;
  protected resultBuffer: GPUBuffer | null = null;

  // Double-buffered staging
  protected stagingBufferA: GPUBuffer | null = null;
  protected stagingBufferB: GPUBuffer | null = null;
  protected currentStagingBuffer: "A" | "B" = "A";
  protected mappedPromise: Promise<void> | null = null;

  protected device: GPUDevice | null = null;
  protected initialized = false;

  /**
   * Define the buffer layout for TResult
   * Example: { stride: 4, fields: { height: 0, normalX: 1, normalY: 2, terrainType: 3 } }
   */
  abstract getResultLayout(): ResultLayout;

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

  @on("add")
  onAdd(): void {
    const webgpu = getWebGPU();
    if (!webgpu) {
      console.warn(this.constructor.name + ": WebGPU not available");
      return;
    }
    this.device = webgpu.device;
    this.initializeBuffers();
  }

  @on("tick")
  async onTick(_dt: number): Promise<void> {
    if (!this.initialized || !this.device) return;

    // 1. Wait for previous staging buffer
    if (this.mappedPromise) {
      await this.mappedPromise;
      this.readAndDistributeResults();
    }

    // 2. Collect query points
    const { points, queries } = this.collectPoints();

    // 3. Upload to GPU
    this.uploadPoints(points);

    // 4. Dispatch compute (stub in Phase 1)
    this.dispatchCompute(queries.length);

    // 5. Copy to staging
    const nextBuffer =
      this.currentStagingBuffer === "A"
        ? this.stagingBufferB!
        : this.stagingBufferA!;
    this.copyToStaging(nextBuffer);

    // 6. Swap and start async map
    this.currentStagingBuffer = this.currentStagingBuffer === "A" ? "B" : "A";
    this.mappedPromise = nextBuffer.mapAsync(GPUMapMode.READ);
  }

  @on("destroy")
  onDestroy(): void {
    this.destroyBuffers();
  }

  protected initializeBuffers(): void {
    if (!this.device) return;

    const layout = this.getResultLayout();

    // Point buffer: vec2f per point
    this.pointBuffer = this.device.createBuffer({
      label: this.constructor.name + " Point Buffer",
      size: this.maxPoints * 2 * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Result buffer: layout.stride floats per result
    this.resultBuffer = this.device.createBuffer({
      label: this.constructor.name + " Result Buffer",
      size: this.maxPoints * layout.stride * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    // Staging buffers
    const stagingSize =
      this.maxPoints * layout.stride * Float32Array.BYTES_PER_ELEMENT;

    this.stagingBufferA = this.device.createBuffer({
      label: this.constructor.name + " Staging A",
      size: stagingSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    this.stagingBufferB = this.device.createBuffer({
      label: this.constructor.name + " Staging B",
      size: stagingSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    this.initialized = true;
  }

  protected collectPoints(): {
    points: Float32Array;
    queries: BaseQuery<TResult>[];
  } {
    const queries = this.getQueries();
    const points = new Float32Array(this.maxPoints * 2);
    let offset = 0;

    for (const query of queries) {
      const queryPoints = query.getQueryPoints();

      if (offset + queryPoints.length > this.maxPoints) {
        console.warn(
          this.constructor.name +
            ": Buffer overflow! Skipping " +
            queryPoints.length +
            " points.",
        );
        query.bufferOffset = -1;
        query.bufferCount = 0;
        continue;
      }

      query.bufferOffset = offset;
      query.bufferCount = queryPoints.length;

      for (const p of queryPoints) {
        points[offset * 2] = p.x;
        points[offset * 2 + 1] = p.y;
        offset++;
      }
    }

    return { points, queries };
  }

  protected uploadPoints(points: Float32Array): void {
    if (!this.device || !this.pointBuffer) return;
    this.device.queue.writeBuffer(
      this.pointBuffer,
      0,
      points.buffer,
      points.byteOffset,
      points.byteLength,
    );
  }

  protected dispatchCompute(pointCount: number): void {
    // Phase 1: Generate stub data
    if (!this.device || !this.resultBuffer) return;

    const layout = this.getResultLayout();
    const data = new Float32Array(this.maxPoints * layout.stride);

    // Fill with stub data - subclasses can override
    this.generateStubData(data, pointCount);

    this.device.queue.writeBuffer(
      this.resultBuffer,
      0,
      data.buffer,
      data.byteOffset,
      data.byteLength,
    );
  }

  /**
   * Generate stub data for Phase 1
   * Override in subclasses for type-specific defaults
   */
  protected generateStubData(data: Float32Array, pointCount: number): void {
    // Default: fill with zeros
    data.fill(0);
  }

  protected copyToStaging(stagingBuffer: GPUBuffer): void {
    if (!this.device || !this.resultBuffer) return;

    const layout = this.getResultLayout();
    const commandEncoder = this.device.createCommandEncoder({
      label: this.constructor.name + " Copy to Staging",
    });

    commandEncoder.copyBufferToBuffer(
      this.resultBuffer,
      0,
      stagingBuffer,
      0,
      this.maxPoints * layout.stride * Float32Array.BYTES_PER_ELEMENT,
    );

    this.device.queue.submit([commandEncoder.finish()]);
  }

  protected readAndDistributeResults(): void {
    const buffer =
      this.currentStagingBuffer === "A"
        ? this.stagingBufferA!
        : this.stagingBufferB!;

    const data = new Float32Array(buffer.getMappedRange());
    const queries = this.getQueries();
    const layout = this.getResultLayout();

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

  protected destroyBuffers(): void {
    this.pointBuffer?.destroy();
    this.resultBuffer?.destroy();
    this.stagingBufferA?.destroy();
    this.stagingBufferB?.destroy();
  }
}
