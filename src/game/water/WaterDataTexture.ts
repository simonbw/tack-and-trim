import { profiler } from "../../core/util/Profiler";
import { WaterInfo } from "./WaterInfo";

const TEXTURE_SIZE = 128;

// Update every Nth pixel each frame, cycling through offsets.
// Higher = less work per frame, but more latency for updates.
const UPDATE_STRIDE = 1;

// Scale factors for packing floats into 0-255 range
// Height: 127 is neutral, 0 is max trough (-2.5 units), 255 is max peak (+2.5 units)
const HEIGHT_OFFSET = 127;
const HEIGHT_SCALE = 255 / 5; // ±2.5 units maps to 0-255
const VELOCITY_SCALE = 255 / 100; // Map -50 to +50 to 0-255 (with 127.5 as zero)
const VELOCITY_OFFSET = 127.5;

// Foam advection configuration
const FOAM_DECAY_RATE = 0.985; // Per-frame decay (foam fades over ~5 seconds at 60fps)
const FOAM_GENERATION_HEIGHT_THRESHOLD = 0.6; // Normalized height above which foam generates
const FOAM_GENERATION_RATE = 0.15; // How much foam is added per frame at peaks
const FOAM_ADVECTION_SCALE = 0.3; // How much velocity affects foam movement (lower = slower drift)

export interface Viewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Creates and maintains a data texture containing water state information.
 * The texture is sampled by the water shader to render height-based coloring.
 *
 * Uses partial updates: only a slice of rows is updated each frame,
 * cycling through all slices over NUM_SLICES frames. This trades temporal
 * resolution for performance.
 *
 * Each texel contains (packed as RGBA8):
 * - R: surface height (0-255 maps to 0-5 units)
 * - G: velocity X (0-255 maps to -50 to +50)
 * - B: velocity Y (0-255 maps to -50 to +50)
 * - A: foam amount (0-255 maps to 0.0-1.0 foam density)
 */
export class WaterDataTexture {
  private dataArray: Uint8Array;
  private glTexture: WebGLTexture | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private currentOffset: number = 0;

  // Foam state tracking for advection
  private foamArray: Float32Array;
  private foamArrayPrev: Float32Array; // Double buffer for advection
  private lastViewport: Viewport | null = null;

  constructor() {
    // Create RGBA8 array for texture data
    this.dataArray = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
    // Create foam state arrays (double-buffered for advection)
    this.foamArray = new Float32Array(TEXTURE_SIZE * TEXTURE_SIZE);
    this.foamArrayPrev = new Float32Array(TEXTURE_SIZE * TEXTURE_SIZE);
  }

  /** Initialize the WebGL texture. Must be called with the GL context. */
  initGL(gl: WebGL2RenderingContext): void {
    this.gl = gl;
    this.glTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.glTexture);

    // Set texture parameters for linear filtering
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Allocate texture with initial data
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      TEXTURE_SIZE,
      TEXTURE_SIZE,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.dataArray
    );
  }

  /**
   * Update a portion of the texture with water state data for the current viewport.
   * Updates every Nth pixel, cycling through offsets each frame.
   * Also handles foam advection - foam drifts with water velocity.
   */
  update(viewport: Viewport, waterInfo: WaterInfo): void {
    if (!this.gl || !this.glTexture) return;

    profiler.start("water-data-texture");
    const { left, top, width, height } = viewport;
    const cellWidth = width / TEXTURE_SIZE;
    const cellHeight = height / TEXTURE_SIZE;

    // Update every Nth pixel starting at current offset
    profiler.start("water-update-slice");
    waterInfo.writeStateToTexture(
      this.dataArray,
      this.currentOffset,
      UPDATE_STRIDE,
      left,
      top,
      cellWidth,
      cellHeight,
      TEXTURE_SIZE,
      HEIGHT_SCALE,
      HEIGHT_OFFSET,
      VELOCITY_SCALE,
      VELOCITY_OFFSET
    );
    profiler.end("water-update-slice");

    // Foam advection - foam drifts with water velocity, decays, regenerates at peaks
    profiler.start("foam-advection");
    this.advectFoam(viewport, cellWidth, cellHeight);
    profiler.end("foam-advection");

    // Advance to next offset for next frame
    this.currentOffset = (this.currentOffset + 1) % UPDATE_STRIDE;
    this.lastViewport = viewport;

    // Upload to GPU
    profiler.start("water-gpu-upload");
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.glTexture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      TEXTURE_SIZE,
      TEXTURE_SIZE,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.dataArray
    );
    profiler.end("water-gpu-upload");
    profiler.end("water-data-texture");
  }

  /**
   * Advect foam using a semi-Lagrangian approach.
   * For each cell, look upstream based on velocity and sample foam from there.
   */
  private advectFoam(
    viewport: Viewport,
    cellWidth: number,
    cellHeight: number
  ): void {
    // Swap buffers - previous becomes source for advection
    const temp = this.foamArrayPrev;
    this.foamArrayPrev = this.foamArray;
    this.foamArray = temp;

    // If viewport changed significantly, clear foam to avoid artifacts
    if (this.lastViewport && this.viewportChanged(viewport)) {
      this.foamArrayPrev.fill(0);
    }

    const invCellWidth = 1 / cellWidth;
    const invCellHeight = 1 / cellHeight;

    for (let y = 0; y < TEXTURE_SIZE; y++) {
      for (let x = 0; x < TEXTURE_SIZE; x++) {
        const idx = y * TEXTURE_SIZE + x;
        const dataIdx = idx * 4;

        // Read velocity from data array (unpack from 0-255)
        const velX =
          (this.dataArray[dataIdx + 1] - VELOCITY_OFFSET) / VELOCITY_SCALE;
        const velY =
          (this.dataArray[dataIdx + 2] - VELOCITY_OFFSET) / VELOCITY_SCALE;

        // Calculate upstream position (semi-Lagrangian: where did this foam come from?)
        // Scale velocity to texel units and apply advection scale for slower drift
        const upstreamX = x - velX * invCellWidth * FOAM_ADVECTION_SCALE;
        const upstreamY = y - velY * invCellHeight * FOAM_ADVECTION_SCALE;

        // Sample foam from upstream position with bilinear interpolation
        const advectedFoam = this.sampleFoamBilinear(upstreamX, upstreamY);

        // Generate new foam based on wave height
        const normalizedHeight =
          (this.dataArray[dataIdx] - HEIGHT_OFFSET) / HEIGHT_SCALE / 2.5 + 0.5;
        const heightAboveThreshold = Math.max(
          0,
          normalizedHeight - FOAM_GENERATION_HEIGHT_THRESHOLD
        );
        const newFoam =
          heightAboveThreshold *
          FOAM_GENERATION_RATE *
          (1 / (1 - FOAM_GENERATION_HEIGHT_THRESHOLD));

        // Combine: decay existing + add new
        const foam = Math.min(1, advectedFoam * FOAM_DECAY_RATE + newFoam);

        // Store in foam array and pack into A channel
        this.foamArray[idx] = foam;
        this.dataArray[dataIdx + 3] = Math.floor(foam * 255);
      }
    }
  }

  /**
   * Bilinear interpolation of foam values.
   */
  private sampleFoamBilinear(x: number, y: number): number {
    // Clamp to valid range
    const clampedX = Math.max(0, Math.min(TEXTURE_SIZE - 1.001, x));
    const clampedY = Math.max(0, Math.min(TEXTURE_SIZE - 1.001, y));

    const x0 = Math.floor(clampedX);
    const y0 = Math.floor(clampedY);
    const x1 = Math.min(x0 + 1, TEXTURE_SIZE - 1);
    const y1 = Math.min(y0 + 1, TEXTURE_SIZE - 1);

    const fx = clampedX - x0;
    const fy = clampedY - y0;

    const f00 = this.foamArrayPrev[y0 * TEXTURE_SIZE + x0];
    const f10 = this.foamArrayPrev[y0 * TEXTURE_SIZE + x1];
    const f01 = this.foamArrayPrev[y1 * TEXTURE_SIZE + x0];
    const f11 = this.foamArrayPrev[y1 * TEXTURE_SIZE + x1];

    // Bilinear interpolation
    const f0 = f00 * (1 - fx) + f10 * fx;
    const f1 = f01 * (1 - fx) + f11 * fx;
    return f0 * (1 - fy) + f1 * fy;
  }

  /**
   * Check if viewport has changed significantly (pan/zoom).
   */
  private viewportChanged(viewport: Viewport): boolean {
    if (!this.lastViewport) return false;
    const threshold = 0.5; // Allow 50% overlap before clearing
    const widthChange =
      Math.abs(viewport.width - this.lastViewport.width) / viewport.width;
    const leftChange =
      Math.abs(viewport.left - this.lastViewport.left) / viewport.width;
    const topChange =
      Math.abs(viewport.top - this.lastViewport.top) / viewport.height;
    return (
      widthChange > threshold || leftChange > threshold || topChange > threshold
    );
  }

  getGLTexture(): WebGLTexture | null {
    return this.glTexture;
  }

  getTextureSize(): number {
    return TEXTURE_SIZE;
  }

  destroy(): void {
    if (this.gl && this.glTexture) {
      this.gl.deleteTexture(this.glTexture);
      this.glTexture = null;
    }
  }
}
