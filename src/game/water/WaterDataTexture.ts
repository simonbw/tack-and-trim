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
 * - A: unused (set to 255)
 */
export class WaterDataTexture {
  private dataArray: Uint8Array;
  private glTexture: WebGLTexture | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private currentOffset: number = 0;

  constructor() {
    // Create RGBA8 array for texture data
    this.dataArray = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
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

    // Advance to next offset for next frame
    this.currentOffset = (this.currentOffset + 1) % UPDATE_STRIDE;

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
