/**
 * Generic GPU readback buffer with double buffering for data tiles.
 *
 * Manages async GPU-to-CPU data transfer for tile-based computation.
 * Configured via DataTileReadbackConfig for domain-specific sample types.
 */

import type { GPUProfiler } from "../../core/graphics/webgpu/GPUProfiler";
import { getWebGPU } from "../../core/graphics/webgpu/WebGPUDevice";
import { asyncProfiler } from "../../core/util/AsyncProfiler";
import { DoubleBuffer } from "../../core/util/DoubleBuffer";
import type { ReadbackViewport } from "./DataTileTypes";

/**
 * Configuration for domain-specific readback behavior.
 */
export interface DataTileReadbackConfig<TSample> {
  /** Number of channels per pixel (2 for rg32float, 4 for rgba32float) */
  channelCount: number;
  /** Bytes per pixel (8 for rg32float, 16 for rgba32float) */
  bytesPerPixel: number;
  /** Label prefix for GPU resources */
  label: string;
  /** Convert raw texel channel data to domain sample type */
  texelToSample(channels: Float32Array): TSample;
  /** Denormalize an interpolated sample to world values */
  denormalize(sample: TSample): TSample;
}

/**
 * Statistics for GPU vs CPU query usage.
 */
export interface DataTileReadbackStats {
  /** Number of queries satisfied from GPU readback */
  gpuHits: number;
  /** Number of queries that fell back to CPU computation */
  cpuFallbacks: number;
  /** Reset counters to zero */
  reset(): void;
}

/**
 * Generic GPU readback buffer with double buffering for data tiles.
 */
export class DataTileReadbackBuffer<TSample> {
  private textureSize: number;
  private config: DataTileReadbackConfig<TSample>;

  // Double buffer for CPU-side data (Float32 after conversion)
  private dataBuffers: DoubleBuffer<Float32Array> | null = null;

  // Double buffer for GPU staging buffers (async readback)
  private stagingBuffers: DoubleBuffer<GPUBuffer> | null = null;

  // Viewport for current read buffer
  private viewport: ReadbackViewport | null = null;
  private pendingViewport: ReadbackViewport | null = null;

  // Pending readback state
  private pendingReadback: Promise<void> | null = null;
  private readbackInProgress = false;

  // Padded row size for GPU texture readback (must be multiple of 256)
  private paddedBytesPerRow: number;

  // Statistics
  readonly stats: DataTileReadbackStats = {
    gpuHits: 0,
    cpuFallbacks: 0,
    reset() {
      this.gpuHits = 0;
      this.cpuFallbacks = 0;
    },
  };

  constructor(textureSize: number, config: DataTileReadbackConfig<TSample>) {
    this.textureSize = textureSize;
    this.config = config;

    // Calculate padded row size (must be multiple of 256 bytes for GPU readback)
    const unpaddedBytesPerRow = textureSize * config.bytesPerPixel;
    this.paddedBytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
  }

  /**
   * Initialize GPU resources.
   */
  async init(): Promise<void> {
    const device = getWebGPU().device;
    const bufferSize = this.paddedBytesPerRow * this.textureSize;

    // Create CPU-side double buffer
    const pixelCount = this.textureSize * this.textureSize;
    const floatsPerBuffer = pixelCount * this.config.channelCount;
    this.dataBuffers = new DoubleBuffer(
      new Float32Array(floatsPerBuffer),
      new Float32Array(floatsPerBuffer),
    );

    // Create GPU staging double buffer
    this.stagingBuffers = new DoubleBuffer(
      device.createBuffer({
        size: bufferSize,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        label: `${this.config.label} Readback Staging A`,
      }),
      device.createBuffer({
        size: bufferSize,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        label: `${this.config.label} Readback Staging B`,
      }),
    );
  }

  /**
   * Initiate async readback from GPU texture.
   * Call at end of tick after GPU compute is submitted.
   */
  initiateReadback(
    outputTexture: GPUTexture,
    viewport: ReadbackViewport,
    _gpuProfiler?: GPUProfiler | null,
  ): void {
    if (!this.stagingBuffers || this.readbackInProgress) {
      return;
    }

    const device = getWebGPU().device;
    const writeStaging = this.stagingBuffers.getWrite();

    // Copy texture to staging buffer
    const commandEncoder = device.createCommandEncoder({
      label: `${this.config.label} Readback Copy`,
    });

    commandEncoder.copyTextureToBuffer(
      { texture: outputTexture },
      { buffer: writeStaging, bytesPerRow: this.paddedBytesPerRow },
      { width: this.textureSize, height: this.textureSize },
    );

    device.queue.submit([commandEncoder.finish()]);

    // Store pending viewport
    this.pendingViewport = viewport;

    // Start async mapping
    this.readbackInProgress = true;
    this.pendingReadback = writeStaging
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        // Readback complete, will be processed in completeReadback()
      })
      .catch(() => {
        console.warn(`${this.config.label} readback mapping failed`);
        this.readbackInProgress = false;
      });
  }

  /**
   * Check if there's a pending readback to complete.
   */
  hasPendingReadback(): boolean {
    return this.pendingReadback !== null && this.readbackInProgress;
  }

  /**
   * Complete pending readback and swap buffers.
   * Call at start of next tick.
   */
  async completeReadback(): Promise<boolean> {
    if (!this.pendingReadback || !this.readbackInProgress) {
      return false;
    }

    try {
      await this.pendingReadback;

      if (!this.stagingBuffers || !this.dataBuffers || !this.pendingViewport) {
        this.readbackInProgress = false;
        return false;
      }

      // Track CPU time spent processing the readback data
      const token = asyncProfiler.startAsync(
        `${this.config.label}.readbackProcess`,
      );
      try {
        const writeStaging = this.stagingBuffers.getWrite();
        const writeBuffer = this.dataBuffers.getWrite();

        // Get the mapped range
        const mappedRange = writeStaging.getMappedRange();
        const rawData = new Float32Array(mappedRange);

        // Copy float32 data, handling GPU row padding
        const floatsPerRow = this.textureSize * this.config.channelCount;
        const paddedFloatsPerRow = this.paddedBytesPerRow / 4; // 4 bytes per float

        // Check if rows are contiguous (no padding) - common case
        if (floatsPerRow === paddedFloatsPerRow) {
          // Fast path: single bulk copy
          writeBuffer.set(rawData.subarray(0, writeBuffer.length));
        } else {
          // Slow path: copy row by row to handle padding
          for (let y = 0; y < this.textureSize; y++) {
            const srcOffset = y * paddedFloatsPerRow;
            const dstOffset = y * floatsPerRow;
            writeBuffer.set(
              rawData.subarray(srcOffset, srcOffset + floatsPerRow),
              dstOffset,
            );
          }
        }

        // Unmap staging buffer
        writeStaging.unmap();

        // Swap buffers
        this.dataBuffers.swap();
        this.stagingBuffers.swap();
        this.viewport = this.pendingViewport;
      } finally {
        asyncProfiler.endAsync(token);
      }

      this.pendingReadback = null;
      this.pendingViewport = null;
      this.readbackInProgress = false;

      return true;
    } catch {
      console.warn(`${this.config.label} readback completion failed`);
      this.pendingReadback = null;
      this.readbackInProgress = false;
      return false;
    }
  }

  /**
   * Sample at world position using bilinear interpolation.
   * Returns null if point is outside the computed viewport.
   */
  sampleAt(worldX: number, worldY: number): TSample | null {
    if (!this.dataBuffers || !this.viewport) {
      this.stats.cpuFallbacks++;
      return null;
    }

    const { left, top, width, height } = this.viewport;

    // Convert world coords to UV (0-1)
    const u = (worldX - left) / width;
    const v = (worldY - top) / height;

    // Check bounds
    if (u < 0 || u > 1 || v < 0 || v > 1) {
      this.stats.cpuFallbacks++;
      return null;
    }

    this.stats.gpuHits++;

    // Convert to texel coordinates
    const texX = u * (this.textureSize - 1);
    const texY = v * (this.textureSize - 1);

    // Bilinear interpolation coordinates
    const x0 = Math.floor(texX);
    const y0 = Math.floor(texY);
    const x1 = Math.min(x0 + 1, this.textureSize - 1);
    const y1 = Math.min(y0 + 1, this.textureSize - 1);
    const fx = texX - x0;
    const fy = texY - y0;

    // Sample 4 corners
    const s00 = this.sampleTexel(x0, y0);
    const s10 = this.sampleTexel(x1, y0);
    const s01 = this.sampleTexel(x0, y1);
    const s11 = this.sampleTexel(x1, y1);

    // Bilinear interpolation in normalized space, then denormalize
    const interpolated = this.interpolateBilinear(s00, s10, s01, s11, fx, fy);
    return this.config.denormalize(interpolated);
  }

  /**
   * Sample a single texel from the read buffer.
   */
  private sampleTexel(x: number, y: number): TSample {
    const readBuffer = this.dataBuffers!.getRead();
    const idx = (y * this.textureSize + x) * this.config.channelCount;
    const channels = readBuffer.subarray(idx, idx + this.config.channelCount);
    return this.config.texelToSample(channels);
  }

  /**
   * Bilinear interpolation between 4 samples.
   * Operates on normalized values before denormalization.
   */
  private interpolateBilinear(
    s00: TSample,
    s10: TSample,
    s01: TSample,
    s11: TSample,
    fx: number,
    fy: number,
  ): TSample {
    // Generic interpolation using object keys
    const result = {} as TSample;
    const keys = Object.keys(s00 as object) as (keyof TSample)[];

    for (const key of keys) {
      const v00 = s00[key] as number;
      const v10 = s10[key] as number;
      const v01 = s01[key] as number;
      const v11 = s11[key] as number;

      const v0 = v00 * (1 - fx) + v10 * fx;
      const v1 = v01 * (1 - fx) + v11 * fx;
      (result as Record<keyof TSample, number>)[key] = v0 * (1 - fy) + v1 * fy;
    }

    return result;
  }

  /**
   * Get the time value used for the current buffer.
   */
  getComputedTime(): number | null {
    return this.viewport?.time ?? null;
  }

  /**
   * Check if a point is within the computed viewport.
   */
  isInViewport(worldX: number, worldY: number): boolean {
    if (!this.viewport) return false;

    const { left, top, width, height } = this.viewport;
    const u = (worldX - left) / width;
    const v = (worldY - top) / height;

    return u >= 0 && u <= 1 && v >= 0 && v <= 1;
  }

  /**
   * Check if the readback buffer has valid data ready for sampling.
   */
  isReady(): boolean {
    return this.dataBuffers !== null && this.viewport !== null;
  }

  /**
   * Get the current viewport bounds.
   */
  getViewport(): ReadbackViewport | null {
    return this.viewport;
  }

  /**
   * Destroy GPU resources.
   */
  destroy(): void {
    if (this.stagingBuffers) {
      this.stagingBuffers.getRead().destroy();
      this.stagingBuffers.getWrite().destroy();
      this.stagingBuffers = null;
    }
    this.dataBuffers = null;
    this.viewport = null;
    this.pendingViewport = null;
    this.pendingReadback = null;
  }
}
