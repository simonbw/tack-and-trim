/**
 * Per-frame CPU+GPU storage for instance transforms.
 *
 * Each Transform struct lays out as 16 floats (64 bytes), std430-friendly:
 *   modelCol0: vec2  (offset  0)
 *   modelCol1: vec2  (offset  8)
 *   modelCol2: vec2  (offset 16)
 *   zCoeffs:   vec2  (offset 24)
 *   zDepth:    vec4  (offset 32)  — (zRow.x, zRow.y, zRow.z, zBase)
 *   tint:      vec4  (offset 48)
 *
 * Slot 0 is reserved as the identity-root transform (untinted, no parallax).
 * On overflow, alloc returns 0 so the caller renders in root space — visually
 * wrong for the offending primitive, but non-crashing.
 */

export const MAX_INSTANCES_PER_FRAME = 4096;
export const TRANSFORM_STRIDE_FLOATS = 16;
const TRANSFORM_STRIDE_BYTES = TRANSFORM_STRIDE_FLOATS * 4;

export interface Transform {
  modelCol0X: number;
  modelCol0Y: number;
  modelCol1X: number;
  modelCol1Y: number;
  modelCol2X: number;
  modelCol2Y: number;
  zCoeffX: number;
  zCoeffY: number;
  zRowX: number;
  zRowY: number;
  zRowZ: number;
  zBase: number;
  tintR: number;
  tintG: number;
  tintB: number;
  tintA: number;
}

export class TransformBuffer {
  private readonly cpuBuffer: Float32Array;
  private gpuBuffer: GPUBuffer | null = null;
  private count: number = 0;
  private overflowWarned = false;

  constructor(public readonly capacity: number = MAX_INSTANCES_PER_FRAME) {
    this.cpuBuffer = new Float32Array(capacity * TRANSFORM_STRIDE_FLOATS);
    this.writeIdentity(0);
    this.count = 1;
  }

  /** Size of each instance in bytes; useful for binding layout. */
  get strideBytes(): number {
    return TRANSFORM_STRIDE_BYTES;
  }

  /** Number of slots used this frame (includes the identity at index 0). */
  get used(): number {
    return this.count;
  }

  /**
   * Reset for a new frame. The identity transform at slot 0 is preserved.
   * `overflowWarned` intentionally persists — if one frame overflows, later
   * frames usually do too, and we don't want to spam once-per-frame.
   */
  reset(): void {
    this.count = 1;
  }

  /**
   * Allocate a new slot and write `t` into it.
   * Returns the slot index, or 0 on overflow (identity root).
   */
  alloc(t: Transform): number {
    if (this.count >= this.capacity) {
      if (!this.overflowWarned) {
        console.warn(
          `[TransformBuffer] overflow: more than ${this.capacity} transforms in one frame, rendering affected primitives in identity space`,
        );
        this.overflowWarned = true;
      }
      return 0;
    }
    const idx = this.count++;
    this.writeSlot(idx, t);
    return idx;
  }

  /** Ensure the GPU buffer is created and at least as large as needed. */
  ensureGpuBuffer(device: GPUDevice): GPUBuffer {
    if (this.gpuBuffer) return this.gpuBuffer;
    this.gpuBuffer = device.createBuffer({
      label: "TransformBuffer",
      size: this.capacity * TRANSFORM_STRIDE_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    return this.gpuBuffer;
  }

  /** Upload the CPU-side range [0, used) to the GPU buffer. */
  upload(device: GPUDevice): GPUBuffer {
    const buf = this.ensureGpuBuffer(device);
    const byteLength = this.count * TRANSFORM_STRIDE_BYTES;
    device.queue.writeBuffer(
      buf,
      0,
      this.cpuBuffer.buffer,
      this.cpuBuffer.byteOffset,
      byteLength,
    );
    return buf;
  }

  /** Free the GPU buffer (called on renderer dispose). */
  dispose(): void {
    if (this.gpuBuffer) {
      this.gpuBuffer.destroy();
      this.gpuBuffer = null;
    }
  }

  private writeIdentity(slot: number): void {
    const o = slot * TRANSFORM_STRIDE_FLOATS;
    const b = this.cpuBuffer;
    b[o + 0] = 1;
    b[o + 1] = 0; // modelCol0
    b[o + 2] = 0;
    b[o + 3] = 1; // modelCol1
    b[o + 4] = 0;
    b[o + 5] = 0; // modelCol2
    b[o + 6] = 0;
    b[o + 7] = 0; // zCoeffs
    b[o + 8] = 0;
    b[o + 9] = 0;
    b[o + 10] = 1;
    b[o + 11] = 0; // zDepth
    b[o + 12] = 1;
    b[o + 13] = 1;
    b[o + 14] = 1;
    b[o + 15] = 1; // tint
  }

  private writeSlot(slot: number, t: Transform): void {
    const o = slot * TRANSFORM_STRIDE_FLOATS;
    const b = this.cpuBuffer;
    b[o + 0] = t.modelCol0X;
    b[o + 1] = t.modelCol0Y;
    b[o + 2] = t.modelCol1X;
    b[o + 3] = t.modelCol1Y;
    b[o + 4] = t.modelCol2X;
    b[o + 5] = t.modelCol2Y;
    b[o + 6] = t.zCoeffX;
    b[o + 7] = t.zCoeffY;
    b[o + 8] = t.zRowX;
    b[o + 9] = t.zRowY;
    b[o + 10] = t.zRowZ;
    b[o + 11] = t.zBase;
    b[o + 12] = t.tintR;
    b[o + 13] = t.tintG;
    b[o + 14] = t.tintB;
    b[o + 15] = t.tintA;
  }
}
