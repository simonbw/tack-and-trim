/**
 * Manages async GPU readback with double buffering for wind velocity data.
 *
 * The GPU computes wind velocity (vx, vy) into a texture. This class:
 * 1. Initiates async readback from GPU texture to staging buffer
 * 2. Double-buffers so physics can read from one buffer while GPU writes to another
 * 3. Provides bilinear-interpolated sampling for world-space queries
 * 4. Tracks GPU vs CPU usage statistics
 */

import { GPUProfiler } from "../../../core/graphics/webgpu/GPUProfiler";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import { WIND_VELOCITY_SCALE } from "../WindConstants";

/**
 * Viewport bounds used for the computation.
 */
export interface WindReadbackViewport {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Time value used for this computation */
  time: number;
}

/**
 * Wind velocity at a point.
 */
export interface WindVelocity {
  velocityX: number;
  velocityY: number;
}

/**
 * Statistics for GPU vs CPU query usage.
 */
export interface WindReadbackStats {
  /** Number of queries satisfied from GPU readback */
  gpuHits: number;
  /** Number of queries that fell back to CPU computation */
  cpuFallbacks: number;
  /** Reset counters to zero */
  reset(): void;
}

/**
 * Convert a Float16 value (stored in a Uint16) to Float32.
 */
function float16ToFloat32(h: number): number {
  const sign = (h >> 15) & 0x1;
  const exponent = (h >> 10) & 0x1f;
  const mantissa = h & 0x3ff;

  if (exponent === 0) {
    if (mantissa === 0) {
      return sign ? -0 : 0;
    }
    const m = mantissa / 1024;
    const value = m * Math.pow(2, -14);
    return sign ? -value : value;
  } else if (exponent === 31) {
    if (mantissa === 0) {
      return sign ? -Infinity : Infinity;
    }
    return NaN;
  }

  const e = exponent - 15;
  const m = 1 + mantissa / 1024;
  const value = m * Math.pow(2, e);
  return sign ? -value : value;
}

/**
 * Manages async GPU readback with double buffering for wind data.
 */
export class WindReadbackBuffer {
  private textureSize: number;

  // Double buffer for CPU-side data (Float32 after conversion)
  // 2 floats per pixel for RG (velocity X and Y)
  private bufferA: Float32Array | null = null;
  private bufferB: Float32Array | null = null;
  private readBuffer: Float32Array | null = null;

  // GPU staging buffers for async readback
  private stagingBufferA: GPUBuffer | null = null;
  private stagingBufferB: GPUBuffer | null = null;
  private writeStaging: GPUBuffer | null = null;

  // Viewport for current read buffer
  private viewport: WindReadbackViewport | null = null;
  private pendingViewport: WindReadbackViewport | null = null;

  // Pending readback state
  private pendingReadback: Promise<void> | null = null;
  private readbackInProgress = false;

  // Padded row size for GPU texture readback (must be multiple of 256)
  private paddedBytesPerRow: number;

  // Statistics
  readonly stats: WindReadbackStats = {
    gpuHits: 0,
    cpuFallbacks: 0,
    reset() {
      this.gpuHits = 0;
      this.cpuFallbacks = 0;
    },
  };

  constructor(textureSize: number) {
    this.textureSize = textureSize;

    // Calculate padded row size (must be multiple of 256 bytes for GPU readback)
    // rg16float = 2 channels * 2 bytes = 4 bytes per pixel
    const bytesPerPixel = 4;
    const unpaddedBytesPerRow = textureSize * bytesPerPixel;
    this.paddedBytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
  }

  /**
   * Initialize GPU resources.
   */
  async init(): Promise<void> {
    const device = getWebGPU().device;
    const bufferSize = this.paddedBytesPerRow * this.textureSize;

    // Create CPU-side buffers (2 floats per pixel for RG)
    const pixelCount = this.textureSize * this.textureSize;
    this.bufferA = new Float32Array(pixelCount * 2);
    this.bufferB = new Float32Array(pixelCount * 2);
    this.readBuffer = this.bufferA;

    // Create GPU staging buffers
    this.stagingBufferA = device.createBuffer({
      size: bufferSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      label: "Wind Readback Staging A",
    });

    this.stagingBufferB = device.createBuffer({
      size: bufferSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      label: "Wind Readback Staging B",
    });

    this.writeStaging = this.stagingBufferA;
  }

  /**
   * Initiate async readback from GPU texture.
   * Call at end of tick after GPU compute is submitted.
   */
  initiateReadback(
    outputTexture: GPUTexture,
    viewport: WindReadbackViewport,
    gpuProfiler?: GPUProfiler | null,
  ): void {
    if (!this.writeStaging || this.readbackInProgress) {
      return;
    }

    const device = getWebGPU().device;

    // Copy texture to staging buffer
    const commandEncoder = device.createCommandEncoder({
      label: "Wind Readback Copy",
    });

    // Write start timestamp for profiling
    gpuProfiler?.writeTimestamp("readback", "start", commandEncoder);

    commandEncoder.copyTextureToBuffer(
      { texture: outputTexture },
      { buffer: this.writeStaging, bytesPerRow: this.paddedBytesPerRow },
      { width: this.textureSize, height: this.textureSize },
    );

    // Write end timestamp for profiling
    gpuProfiler?.writeTimestamp("readback", "end", commandEncoder);

    device.queue.submit([commandEncoder.finish()]);

    // Store pending viewport
    this.pendingViewport = viewport;

    // Start async mapping
    this.readbackInProgress = true;
    this.pendingReadback = this.writeStaging
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        // Readback complete, will be processed in completeReadback()
      })
      .catch((error) => {
        console.warn("Wind readback mapping failed:", error);
        this.readbackInProgress = false;
      });
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

      if (!this.writeStaging || !this.pendingViewport) {
        this.readbackInProgress = false;
        return false;
      }

      // Get the mapped range
      const mappedRange = this.writeStaging.getMappedRange();
      const rawData = new Uint16Array(mappedRange);

      // Determine which CPU buffer to write to
      const writeBuffer =
        this.readBuffer === this.bufferA ? this.bufferB : this.bufferA;

      if (!writeBuffer) {
        this.writeStaging.unmap();
        this.readbackInProgress = false;
        return false;
      }

      // Convert float16 to float32 and unpad rows
      // rg16float = 2 channels per pixel, 4 bytes per pixel
      const pixelsPerRow = this.textureSize;
      const paddedPixelsPerRow = this.paddedBytesPerRow / 4; // 4 bytes per rg16f pixel
      const channelsPerPixel = 2;

      for (let y = 0; y < this.textureSize; y++) {
        for (let x = 0; x < pixelsPerRow; x++) {
          const srcIdx = (y * paddedPixelsPerRow + x) * channelsPerPixel;
          const dstIdx = (y * pixelsPerRow + x) * channelsPerPixel;

          // Convert each channel from float16 to float32
          writeBuffer[dstIdx + 0] = float16ToFloat32(rawData[srcIdx + 0]); // R: velocity X
          writeBuffer[dstIdx + 1] = float16ToFloat32(rawData[srcIdx + 1]); // G: velocity Y
        }
      }

      // Unmap staging buffer
      this.writeStaging.unmap();

      // Swap buffers
      this.readBuffer = writeBuffer;
      this.viewport = this.pendingViewport;

      // Swap staging buffers for next readback
      this.writeStaging =
        this.writeStaging === this.stagingBufferA
          ? this.stagingBufferB
          : this.stagingBufferA;

      this.pendingReadback = null;
      this.pendingViewport = null;
      this.readbackInProgress = false;

      return true;
    } catch (error) {
      console.warn("Wind readback completion failed:", error);
      this.pendingReadback = null;
      this.readbackInProgress = false;
      return false;
    }
  }

  /**
   * Sample wind velocity at world position using bilinear interpolation.
   * Returns null if point is outside the computed viewport.
   */
  sampleAt(worldX: number, worldY: number): WindVelocity | null {
    if (!this.readBuffer || !this.viewport) {
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

    // Bilinear interpolation
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

    // Interpolate velocity X (R channel)
    const vx0 = s00.velocityX * (1 - fx) + s10.velocityX * fx;
    const vx1 = s01.velocityX * (1 - fx) + s11.velocityX * fx;
    const normalizedVx = vx0 * (1 - fy) + vx1 * fy;

    // Interpolate velocity Y (G channel)
    const vy0 = s00.velocityY * (1 - fx) + s10.velocityY * fx;
    const vy1 = s01.velocityY * (1 - fx) + s11.velocityY * fx;
    const normalizedVy = vy0 * (1 - fy) + vy1 * fy;

    // Denormalize (GPU stores as velocity / WIND_VELOCITY_SCALE + 0.5)
    return {
      velocityX: (normalizedVx - 0.5) * WIND_VELOCITY_SCALE,
      velocityY: (normalizedVy - 0.5) * WIND_VELOCITY_SCALE,
    };
  }

  /**
   * Sample a single texel from the read buffer.
   */
  private sampleTexel(x: number, y: number): WindVelocity {
    const idx = (y * this.textureSize + x) * 2;
    return {
      velocityX: this.readBuffer![idx + 0], // R channel (normalized velocity X)
      velocityY: this.readBuffer![idx + 1], // G channel (normalized velocity Y)
    };
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
    return this.readBuffer !== null && this.viewport !== null;
  }

  /**
   * Get the current viewport bounds.
   */
  getViewport(): WindReadbackViewport | null {
    return this.viewport;
  }

  /**
   * Destroy GPU resources.
   */
  destroy(): void {
    this.stagingBufferA?.destroy();
    this.stagingBufferB?.destroy();
    this.stagingBufferA = null;
    this.stagingBufferB = null;
    this.bufferA = null;
    this.bufferB = null;
    this.readBuffer = null;
    this.writeStaging = null;
    this.viewport = null;
    this.pendingViewport = null;
    this.pendingReadback = null;
  }
}
