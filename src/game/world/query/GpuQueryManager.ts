import { on } from "../../../core/entity/handler";

import { DoubleBuffer } from "../../../core/util/DoubleBuffer";
import { profile, profileAsync, profiler } from "../../../core/util/Profiler";
import { QueryManager, STRIDE_PER_POINT } from "./QueryManager";

/**
 * GPU-accelerated query manager.
 *
 * Runs queries via WebGPU compute shaders with asynchronous readback.
 *
 * Features:
 * - Type-safe buffer management with named field layouts
 * - Double-buffered readback for non-blocking GPU data access
 * - Automatic query discovery via tags
 * - One-frame latency (results available next frame)
 * - Zero-allocation result delivery via buffer-backed views
 */
export abstract class GpuQueryManager extends QueryManager {
  /**
   * When true, this manager's afterPhysicsStep is a no-op.
   * A GpuQueryCoordinator will call the individual dispatch phases instead,
   * batching all managers onto a single command encoder for GPU parallelism.
   */
  coordinated = false;

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
   * Persistent CPU-side buffer for result data.
   * Mapped GPU data is copied here immediately, then the GPU buffer is unmapped.
   * Query views reference slices of this buffer.
   */
  private dataBuffer: Float32Array | null = null;

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

  /**
   * Dispatch GPU compute shader.
   * Creates a compute pass, records the dispatch, and ends the pass.
   *
   * @param pointCount Number of points to process
   * @param commandEncoder Command encoder to record the compute pass onto
   */
  abstract dispatchCompute(
    pointCount: number,
    commandEncoder: GPUCommandEncoder,
  ): void;

  /**
   * Hook invoked once per frame immediately before results are distributed
   * to queries. Subclasses override to promote their "pending" dispatch
   * params snapshot into a "last completed" slot so external code (e.g.,
   * the parity check) can correlate query results to the exact uniforms
   * used to produce them.
   *
   * Default is a no-op — subclasses that don't need the snapshot skip it.
   */
  protected onResultsReady(): void {}

  @on("add")
  onAdd(): void {
    const device = this.game.getWebGPUDevice();

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

      const mappedView = new Float32Array(
        readbackBuffer.getMappedRange(0, this.pendingReadbackBytes),
      );

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
      mappedSuccessfully = false;

      // Give subclasses a chance to promote "pending" dispatch params
      // into "last completed" — the parity check relies on this so it
      // can correlate query results to the exact uniforms used.
      this.onResultsReady();
      this.distributeResults(this.dataBuffer);
    } catch (error) {
      console.warn(
        `[${this.constructor.name}] Query readback failed (context loss?):`,
        (error as Error).message,
      );
    } finally {
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

  /**
   * Collect query points and upload to GPU.
   * Returns the point count (0 means skip this manager).
   */
  collectAndUploadPoints(): number {
    const { points, pointCount } = this.collectPoints();
    if (pointCount === 0) return 0;

    const pointBytesNeeded =
      pointCount * STRIDE_PER_POINT * Float32Array.BYTES_PER_ELEMENT;
    const device = this.game.getWebGPUDevice();
    device.queue.writeBuffer(
      this.pointBuffer,
      0,
      points.buffer,
      points.byteOffset,
      pointBytesNeeded,
    );

    return pointCount;
  }

  /**
   * Record a copy from resultBuffer to the current write readback buffer.
   */
  recordCopyToReadback(
    pointCount: number,
    commandEncoder: GPUCommandEncoder,
  ): void {
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
  }

  /**
   * Swap double buffers and start async map for next tick's results.
   */
  startReadback(pointCount: number): void {
    const resultBytesNeeded =
      pointCount * this.resultLayout.stride * Float32Array.BYTES_PER_ELEMENT;
    const readbackBuffer = this.readbackBuffers.getWrite();

    this.readbackBuffers.swap();
    this.pendingReadbackBytes = resultBytesNeeded;
    this.readbackPromise = readbackBuffer.mapAsync(
      GPUMapMode.READ,
      0,
      resultBytesNeeded,
    );
  }

  @on("afterPhysicsStep")
  @profile
  onAfterPhysicsStep(): void {
    if (this.coordinated) return;

    const pointCount = this.collectAndUploadPoints();
    if (pointCount === 0) return;

    const device = this.game.getWebGPUDevice();
    const commandEncoder = device.createCommandEncoder({
      label: `${this.constructor.name} Compute + Copy`,
    });

    this.dispatchCompute(pointCount, commandEncoder);
    this.recordCopyToReadback(pointCount, commandEncoder);

    device.queue.submit([commandEncoder.finish()]);

    this.startReadback(pointCount);
  }

  @on("destroy")
  onDestroy(): void {
    // Clear the pending promise so the awaiting onTick won't try to use
    // destroyed buffers.  The mapAsync will reject with AbortError when
    // the buffer is destroyed — we intentionally swallow that below.
    const pendingPromise = this.readbackPromise;
    this.readbackPromise = null;
    pendingPromise?.catch(() => {});

    this.pointBuffer?.destroy();
    this.resultBuffer?.destroy();
    if (this.readbackBuffers) {
      this.readbackBuffers.getRead().destroy();
      this.readbackBuffers.getWrite().destroy();
    }
  }
}
