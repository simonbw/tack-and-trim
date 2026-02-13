/**
 * GPU profiler using WebGPU timestamp queries for accurate GPU timing.
 *
 * Supports multiple named sections (render, surface.water, surface.terrain, etc.)
 * with independent timing for each. Uses double-buffered read buffers to avoid
 * mapping conflicts since mapAsync is asynchronous.
 */

import { asyncProfiler } from "../../util/AsyncProfiler";
import { DoubleBuffer } from "../../util/DoubleBuffer";

/** Available profiling sections */
export type GPUProfileSection = (typeof GPUProfiler)["SECTIONS"][number];

interface SectionData {
  queryStartIndex: number;
  queryEndIndex: number;
  smoothedMs: number;
}

export class GPUProfiler {
  private enabled = false;
  private device: GPUDevice;

  // Section definitions
  private static readonly SECTIONS = [
    "render",
    "surface.water",
    "surface.terrain",
    "surface.rasterize",
    "surface.wetness",
    "query.water",
    "query.wind",
    "query.terrain",
  ] as const;
  private static readonly QUERY_COUNT = GPUProfiler.SECTIONS.length * 2;

  // Query resources
  private querySet: GPUQuerySet;
  private resolveBuffer: GPUBuffer;

  // Double-buffer to avoid mapping conflicts
  private readBuffers: DoubleBuffer<GPUBuffer>;
  private pendingMap = false;

  // Section data with smoothed results
  private sections: Map<GPUProfileSection, SectionData>;
  private readonly smoothing = 0.95;

  constructor(device: GPUDevice) {
    this.device = device;

    // Create query set for all sections (2 queries per section)
    this.querySet = device.createQuerySet({
      type: "timestamp",
      count: GPUProfiler.QUERY_COUNT,
    });

    // Buffer to resolve queries into
    const bufferSize = GPUProfiler.QUERY_COUNT * 8; // 8 bytes per timestamp
    this.resolveBuffer = device.createBuffer({
      size: bufferSize,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });

    // Double-buffered read buffers to avoid mapping conflicts
    this.readBuffers = new DoubleBuffer(
      device.createBuffer({
        size: bufferSize,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      }),
      device.createBuffer({
        size: bufferSize,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      }),
    );

    // Initialize section data with query indices
    this.sections = new Map();
    GPUProfiler.SECTIONS.forEach((section, i) => {
      this.sections.set(section, {
        queryStartIndex: i * 2,
        queryEndIndex: i * 2 + 1,
        smoothedMs: 0,
      });
    });
  }

  /**
   * Get timestampWrites config for a render pass.
   * Returns undefined if profiling is disabled.
   */
  getTimestampWrites(
    section: GPUProfileSection = "render",
  ): GPURenderPassTimestampWrites | undefined {
    if (!this.enabled) return undefined;
    const data = this.sections.get(section);
    if (!data) return undefined;
    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: data.queryStartIndex,
      endOfPassWriteIndex: data.queryEndIndex,
    };
  }

  /**
   * Get timestampWrites that only records the beginning-of-pass timestamp.
   * Use with getTimestampWritesEnd on another pass to span timing across
   * multiple render passes on the same command encoder.
   */
  getTimestampWritesBegin(
    section: GPUProfileSection,
  ): GPURenderPassTimestampWrites | undefined {
    if (!this.enabled) return undefined;
    const data = this.sections.get(section);
    if (!data) return undefined;
    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: data.queryStartIndex,
    };
  }

  /**
   * Get timestampWrites that only records the end-of-pass timestamp.
   * Use with getTimestampWritesBegin on another pass to span timing across
   * multiple render passes on the same command encoder.
   */
  getTimestampWritesEnd(
    section: GPUProfileSection,
  ): GPURenderPassTimestampWrites | undefined {
    if (!this.enabled) return undefined;
    const data = this.sections.get(section);
    if (!data) return undefined;
    return {
      querySet: this.querySet,
      endOfPassWriteIndex: data.queryEndIndex,
    };
  }

  /**
   * Get timestampWrites config for a compute pass.
   * Returns undefined if profiling is disabled.
   */
  getComputeTimestampWrites(
    section: GPUProfileSection,
  ): GPUComputePassTimestampWrites | undefined {
    if (!this.enabled) return undefined;
    const data = this.sections.get(section);
    if (!data) return undefined;
    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: data.queryStartIndex,
      endOfPassWriteIndex: data.queryEndIndex,
    };
  }

  /**
   * Resolve all timestamps and copy to read buffer.
   * Call after all command encoders are finished, before submit.
   */
  resolve(encoder: GPUCommandEncoder): void {
    if (!this.enabled) return;

    // Resolve all timestamps to buffer
    encoder.resolveQuerySet(
      this.querySet,
      0,
      GPUProfiler.QUERY_COUNT,
      this.resolveBuffer,
      0,
    );

    // Copy to mappable read buffer (use the buffer we're NOT currently reading from)
    encoder.copyBufferToBuffer(
      this.resolveBuffer,
      0,
      this.readBuffers.getWrite(),
      0,
      GPUProfiler.QUERY_COUNT * 8,
    );
  }

  /**
   * Start async read of results from previous frame.
   * Call after submit.
   */
  readResults(): void {
    if (!this.enabled || this.pendingMap) return;

    const readBuffer = this.readBuffers.getRead();
    this.pendingMap = true;

    readBuffer
      .mapAsync(GPUMapMode.READ)
      .then(
        asyncProfiler.wrapCallback("GPUProfiler.processResults", () => {
          const times = new BigUint64Array(readBuffer.getMappedRange());

          // Process each section
          for (const [, data] of this.sections) {
            const startNs = times[data.queryStartIndex];
            const endNs = times[data.queryEndIndex];

            // Only update if we have valid timestamps (non-zero)
            if (startNs > 0 && endNs > 0 && endNs >= startNs) {
              const elapsedMs = Number(endNs - startNs) / 1_000_000;
              data.smoothedMs =
                this.smoothing * data.smoothedMs +
                (1 - this.smoothing) * elapsedMs;
            }
          }

          readBuffer.unmap();
          this.pendingMap = false;

          // Swap to other buffer for next frame
          this.readBuffers.swap();
        }),
      )
      .catch(() => {
        // Mapping failed (e.g., buffer already mapped), ignore
        this.pendingMap = false;
      });
  }

  /**
   * Get the smoothed GPU time in milliseconds for a section.
   * Defaults to "render" for backwards compatibility.
   */
  getMs(section: GPUProfileSection = "render"): number {
    return this.sections.get(section)?.smoothedMs ?? 0;
  }

  /**
   * Get all section timings.
   */
  getAllMs(): Record<GPUProfileSection, number> {
    return Object.fromEntries(
      GPUProfiler.SECTIONS.map((section) => [section, this.getMs(section)]),
    ) as Record<GPUProfileSection, number>;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Reset all smoothed values (e.g., when profiler is toggled).
   */
  reset(): void {
    for (const data of this.sections.values()) {
      data.smoothedMs = 0;
    }
  }
}
