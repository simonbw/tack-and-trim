/**
 * Manages async GPU readback with double buffering for water wave data.
 *
 * The GPU computes wave data (height, dh/dt) into a texture. This class:
 * 1. Initiates async readback from GPU texture to staging buffer
 * 2. Double-buffers so physics can read from one buffer while GPU writes to another
 * 3. Provides bilinear-interpolated sampling for world-space queries
 * 4. Tracks GPU vs CPU usage statistics
 */

import { GPUProfiler } from "../../../core/graphics/webgpu/GPUProfiler";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import type { WaveData } from "../cpu/WaterComputeCPU";

/**
 * Viewport bounds used for the computation.
 */
export interface ReadbackViewport {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Time value used for this computation (for CPU fallback consistency) */
  time: number;
}

/**
 * Statistics for GPU vs CPU query usage.
 */
export interface ReadbackStats {
  /** Number of queries satisfied from GPU readback */
  gpuHits: number;
  /** Number of queries that fell back to CPU computation */
  cpuFallbacks: number;
  /** Fallbacks specifically due to low resolution */
  lowResolutionFallbacks: number;
  /** Fallbacks specifically due to being outside viewport bounds */
  outOfBoundsFallbacks: number;
  /** Current resolution in pixels per world unit (at viewport center) */
  currentResolution: number;
  /** Reset counters to zero */
  reset(): void;
}

/**
 * Convert a Float16 value (stored in a Uint16) to Float32.
 * IEEE 754 half-precision format:
 * - 1 bit sign
 * - 5 bits exponent (bias 15)
 * - 10 bits mantissa
 */
function float16ToFloat32(h: number): number {
  const sign = (h >> 15) & 0x1;
  const exponent = (h >> 10) & 0x1f;
  const mantissa = h & 0x3ff;

  if (exponent === 0) {
    if (mantissa === 0) {
      // Zero (positive or negative)
      return sign ? -0 : 0;
    }
    // Subnormal number
    const m = mantissa / 1024;
    const value = m * Math.pow(2, -14);
    return sign ? -value : value;
  } else if (exponent === 31) {
    if (mantissa === 0) {
      // Infinity
      return sign ? -Infinity : Infinity;
    }
    // NaN
    return NaN;
  }

  // Normalized number
  const e = exponent - 15; // Unbias exponent
  const m = 1 + mantissa / 1024; // Add implicit leading 1
  const value = m * Math.pow(2, e);
  return sign ? -value : value;
}

/**
 * Manages async GPU readback with double buffering.
 */
export class WaterReadbackBuffer {
  private textureSize: number;

  // Double buffer for CPU-side data (Float32 after conversion)
  private bufferA: Float32Array | null = null;
  private bufferB: Float32Array | null = null;
  private readBuffer: Float32Array | null = null; // Points to A or B

  // GPU staging buffers for async readback
  private stagingBufferA: GPUBuffer | null = null;
  private stagingBufferB: GPUBuffer | null = null;
  private writeStaging: GPUBuffer | null = null; // Points to A or B

  // Viewport for current read buffer
  private viewport: ReadbackViewport | null = null;
  private pendingViewport: ReadbackViewport | null = null;

  // Pending readback state
  private pendingReadback: Promise<void> | null = null;
  private readbackInProgress = false;

  // Padded row size for GPU texture readback (must be multiple of 256)
  private paddedBytesPerRow: number;

  // Statistics
  readonly stats: ReadbackStats = {
    gpuHits: 0,
    cpuFallbacks: 0,
    lowResolutionFallbacks: 0,
    outOfBoundsFallbacks: 0,
    currentResolution: 0,
    reset() {
      this.gpuHits = 0;
      this.cpuFallbacks = 0;
      this.lowResolutionFallbacks = 0;
      this.outOfBoundsFallbacks = 0;
      // Don't reset currentResolution - it's updated on each frame
    },
  };

  constructor(textureSize: number) {
    this.textureSize = textureSize;

    // Calculate padded row size (must be multiple of 256 bytes for GPU readback)
    const bytesPerPixel = 8; // rgba16float = 4 * 2 bytes
    const unpaddedBytesPerRow = textureSize * bytesPerPixel;
    this.paddedBytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
  }

  /**
   * Initialize GPU resources.
   */
  async init(): Promise<void> {
    const device = getWebGPU().device;
    const bufferSize = this.paddedBytesPerRow * this.textureSize;

    // Create CPU-side buffers (4 floats per pixel for RGBA)
    const pixelCount = this.textureSize * this.textureSize;
    this.bufferA = new Float32Array(pixelCount * 4);
    this.bufferB = new Float32Array(pixelCount * 4);
    this.readBuffer = this.bufferA;

    // Create GPU staging buffers
    this.stagingBufferA = device.createBuffer({
      size: bufferSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      label: "Water Readback Staging A",
    });

    this.stagingBufferB = device.createBuffer({
      size: bufferSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      label: "Water Readback Staging B",
    });

    this.writeStaging = this.stagingBufferA;
  }

  /**
   * Initiate async readback from GPU texture.
   * Call at end of tick after GPU compute is submitted.
   *
   * @param outputTexture The GPU texture to read from
   * @param viewport The world-space bounds of the computed data
   * @param gpuProfiler Optional GPU profiler for timing the readback
   */
  initiateReadback(
    outputTexture: GPUTexture,
    viewport: ReadbackViewport,
    gpuProfiler?: GPUProfiler | null,
  ): void {
    if (!this.writeStaging || this.readbackInProgress) {
      return;
    }

    const device = getWebGPU().device;

    // Copy texture to staging buffer
    const commandEncoder = device.createCommandEncoder({
      label: "Water Readback Copy",
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
        console.warn("Water readback mapping failed:", error);
        this.readbackInProgress = false;
      });
  }

  /**
   * Complete pending readback and swap buffers.
   * Call at start of next tick.
   *
   * @returns True if readback completed successfully, false if still pending
   */
  async completeReadback(): Promise<boolean> {
    if (!this.pendingReadback || !this.readbackInProgress) {
      return false;
    }

    try {
      // Wait for mapping to complete (should already be done in most cases)
      await this.pendingReadback;

      if (!this.writeStaging || !this.pendingViewport) {
        this.readbackInProgress = false;
        return false;
      }

      // Get the mapped range
      const mappedRange = this.writeStaging.getMappedRange();
      const rawData = new Uint16Array(mappedRange);

      // Determine which CPU buffer to write to (opposite of current read buffer)
      const writeBuffer =
        this.readBuffer === this.bufferA ? this.bufferB : this.bufferA;

      if (!writeBuffer) {
        this.writeStaging.unmap();
        this.readbackInProgress = false;
        return false;
      }

      // Convert float16 to float32 and unpad rows
      const pixelsPerRow = this.textureSize;
      const paddedPixelsPerRow = this.paddedBytesPerRow / 8; // 8 bytes per rgba16f pixel
      const channelsPerPixel = 4;

      for (let y = 0; y < this.textureSize; y++) {
        for (let x = 0; x < pixelsPerRow; x++) {
          const srcIdx = (y * paddedPixelsPerRow + x) * channelsPerPixel;
          const dstIdx = (y * pixelsPerRow + x) * channelsPerPixel;

          // Convert each channel from float16 to float32
          writeBuffer[dstIdx + 0] = float16ToFloat32(rawData[srcIdx + 0]); // R: height
          writeBuffer[dstIdx + 1] = float16ToFloat32(rawData[srcIdx + 1]); // G: dhdt
          writeBuffer[dstIdx + 2] = float16ToFloat32(rawData[srcIdx + 2]); // B: unused
          writeBuffer[dstIdx + 3] = float16ToFloat32(rawData[srcIdx + 3]); // A: unused
        }
      }

      // Unmap staging buffer
      this.writeStaging.unmap();

      // Swap buffers
      this.readBuffer = writeBuffer;
      this.viewport = this.pendingViewport;

      // Update resolution stat
      this.stats.currentResolution = this.getResolution();

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
      console.warn("Water readback completion failed:", error);
      this.pendingReadback = null;
      this.readbackInProgress = false;
      return false;
    }
  }

  /**
   * Sample wave data at world position using bilinear interpolation.
   * Returns null if point is outside the computed viewport.
   *
   * @param worldX World X coordinate
   * @param worldY World Y coordinate
   * @returns Wave data or null if outside viewport
   */
  sampleAt(worldX: number, worldY: number): WaveData | null {
    if (!this.readBuffer || !this.viewport) {
      this.stats.cpuFallbacks++;
      return null;
    }

    const { left, top, width, height } = this.viewport;

    // Convert world coords to UV (0-1)
    const u = (worldX - left) / width;
    const v = (worldY - top) / height;

    // Check bounds (with small epsilon for floating point)
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

    // Sample 4 corners (4 floats per pixel: RGBA)
    const s00 = this.sampleTexel(x0, y0);
    const s10 = this.sampleTexel(x1, y0);
    const s01 = this.sampleTexel(x0, y1);
    const s11 = this.sampleTexel(x1, y1);

    // Interpolate height (R channel)
    const h0 = s00.height * (1 - fx) + s10.height * fx;
    const h1 = s01.height * (1 - fx) + s11.height * fx;
    const normalizedHeight = h0 * (1 - fy) + h1 * fy;

    // Interpolate dhdt (G channel)
    const d0 = s00.dhdt * (1 - fx) + s10.dhdt * fx;
    const d1 = s01.dhdt * (1 - fx) + s11.dhdt * fx;
    const normalizedDhdt = d0 * (1 - fy) + d1 * fy;

    // Denormalize (GPU stores as height/5.0 + 0.5, dhdt/10.0 + 0.5)
    return {
      height: (normalizedHeight - 0.5) * 5.0,
      dhdt: (normalizedDhdt - 0.5) * 10.0,
    };
  }

  /**
   * Sample a single texel from the read buffer.
   */
  private sampleTexel(x: number, y: number): { height: number; dhdt: number } {
    const idx = (y * this.textureSize + x) * 4;
    return {
      height: this.readBuffer![idx + 0], // R channel (normalized height)
      dhdt: this.readBuffer![idx + 1], // G channel (normalized dhdt)
    };
  }

  /**
   * Get the time value used for the current buffer.
   * Use this for CPU fallback calculations to maintain consistency.
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
   * Get the current resolution in pixels per world unit.
   * Resolution is uniform across the viewport since the texture size is fixed.
   */
  getResolution(): number {
    if (!this.viewport) return 0;
    // Use the smaller dimension to get the worst-case resolution
    const worldSize = Math.max(this.viewport.width, this.viewport.height);
    return this.textureSize / worldSize;
  }

  /**
   * Check if a point has adequate resolution for physics queries.
   * @param worldX World X coordinate
   * @param worldY World Y coordinate
   * @param minPixelsPerUnit Minimum required pixels per world unit
   * @returns true if resolution is adequate and point is in viewport
   */
  hasAdequateResolution(
    worldX: number,
    worldY: number,
    minPixelsPerUnit: number,
  ): boolean {
    if (!this.isInViewport(worldX, worldY)) {
      return false;
    }
    return this.getResolution() >= minPixelsPerUnit;
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
  getViewport(): ReadbackViewport | null {
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
