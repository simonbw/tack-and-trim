import { VERTEX_STRIDE_FLOATS, VertexSink } from "../tessellation/VertexSink";

/** Floats per vertex in the new shape format: position(2) + color(4) + z(1). */
export const SHAPE_VERTEX_FLOATS = VERTEX_STRIDE_FLOATS; // 7

export const MAX_BATCH_VERTICES = 262_144; // 1 MiB of vertex data (256 KiB of tx indices)
export const MAX_BATCH_INDICES = MAX_BATCH_VERTICES * 6;

const GPU_BUFFER_FLUSH_CAPACITY = 4;

/**
 * CPU-side batch for untextured shape vertices.
 *
 * Implements `VertexSink` so tessellators can write directly. Every call
 * to `reserveVertices(n)` also stamps the batch's current transform index
 * for the n new vertex slots — callers that want a specific transform set
 * `currentTransformIndex` before calling.
 *
 * GPU-side: three buffers (vertexData, txIndexData, indexData). The vertex
 * stream is 28 bytes/vertex; txIndexData is 4 bytes/vertex (u32); indices
 * are Uint32.
 */
export class ShapeBatch implements VertexSink {
  readonly vertexData: Float32Array;
  readonly indexData: Uint32Array;
  readonly txIndexData: Uint32Array;

  vertexCount = 0;
  indexCount = 0;

  /** Transform-buffer slot index to stamp on newly reserved vertices. */
  currentTransformIndex = 0;

  vertexBuffer: GPUBuffer | null = null;
  indexBuffer: GPUBuffer | null = null;
  txIndexBuffer: GPUBuffer | null = null;

  gpuVertexByteOffset = 0;
  gpuIndexByteOffset = 0;
  gpuTxIndexByteOffset = 0;

  constructor(
    readonly maxVertices: number = MAX_BATCH_VERTICES,
    readonly maxIndices: number = MAX_BATCH_INDICES,
  ) {
    this.vertexData = new Float32Array(maxVertices * SHAPE_VERTEX_FLOATS);
    this.txIndexData = new Uint32Array(maxVertices);
    this.indexData = new Uint32Array(maxIndices);
  }

  createGpuBuffers(device: GPUDevice): void {
    if (this.vertexBuffer) return;
    this.vertexBuffer = device.createBuffer({
      size: this.vertexData.byteLength * GPU_BUFFER_FLUSH_CAPACITY,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      label: "Shape Vertex Buffer",
    });
    this.txIndexBuffer = device.createBuffer({
      size: this.txIndexData.byteLength * GPU_BUFFER_FLUSH_CAPACITY,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      label: "Shape TransformIndex Buffer",
    });
    this.indexBuffer = device.createBuffer({
      size: this.indexData.byteLength * GPU_BUFFER_FLUSH_CAPACITY,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      label: "Shape Index Buffer",
    });
  }

  resetFrameOffsets(): void {
    this.gpuVertexByteOffset = 0;
    this.gpuIndexByteOffset = 0;
    this.gpuTxIndexByteOffset = 0;
  }

  resetBatch(): void {
    this.vertexCount = 0;
    this.indexCount = 0;
  }

  // VertexSink impl -----------------------------------------------------------

  reserveVertices(n: number): { base: number; view: Float32Array } {
    const base = this.vertexCount;
    const startFloat = base * SHAPE_VERTEX_FLOATS;
    const view = this.vertexData.subarray(
      startFloat,
      startFloat + n * SHAPE_VERTEX_FLOATS,
    );
    const tx = this.currentTransformIndex;
    for (let i = 0; i < n; i++) this.txIndexData[base + i] = tx;
    this.vertexCount += n;
    return { base, view };
  }

  reserveIndices(n: number): Uint32Array {
    const start = this.indexCount;
    this.indexCount += n;
    return this.indexData.subarray(start, start + n);
  }

  /**
   * Upload + issue one draw command for the currently-accumulated batch.
   * Returns the number of vertices drawn (0 if nothing to flush).
   */
  flush(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    pipeline: GPURenderPipeline,
    bindGroup: GPUBindGroup,
  ): { vertices: number; triangles: number } {
    if (
      this.indexCount === 0 ||
      !this.vertexBuffer ||
      !this.indexBuffer ||
      !this.txIndexBuffer
    ) {
      return { vertices: 0, triangles: 0 };
    }

    const vertexByteSize = this.vertexCount * SHAPE_VERTEX_FLOATS * 4;
    const txByteSize = this.vertexCount * 4;
    // writeBuffer requires 4-byte-aligned sizes; Uint32 is naturally aligned.
    const indexByteSize = this.indexCount * 4;

    const vbCapacity = this.vertexData.byteLength * GPU_BUFFER_FLUSH_CAPACITY;
    const ibCapacity = this.indexData.byteLength * GPU_BUFFER_FLUSH_CAPACITY;
    const tbCapacity = this.txIndexData.byteLength * GPU_BUFFER_FLUSH_CAPACITY;
    if (
      this.gpuVertexByteOffset + vertexByteSize > vbCapacity ||
      this.gpuIndexByteOffset + indexByteSize > ibCapacity ||
      this.gpuTxIndexByteOffset + txByteSize > tbCapacity
    ) {
      this.gpuVertexByteOffset = 0;
      this.gpuIndexByteOffset = 0;
      this.gpuTxIndexByteOffset = 0;
    }

    device.queue.writeBuffer(
      this.vertexBuffer,
      this.gpuVertexByteOffset,
      this.vertexData.buffer,
      this.vertexData.byteOffset,
      vertexByteSize,
    );
    device.queue.writeBuffer(
      this.txIndexBuffer,
      this.gpuTxIndexByteOffset,
      this.txIndexData.buffer,
      this.txIndexData.byteOffset,
      txByteSize,
    );
    device.queue.writeBuffer(
      this.indexBuffer,
      this.gpuIndexByteOffset,
      this.indexData.buffer,
      this.indexData.byteOffset,
      indexByteSize,
    );

    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, this.vertexBuffer, this.gpuVertexByteOffset);
    pass.setVertexBuffer(1, this.txIndexBuffer, this.gpuTxIndexByteOffset);
    pass.setIndexBuffer(this.indexBuffer, "uint32", this.gpuIndexByteOffset);
    pass.drawIndexed(this.indexCount);

    const result = {
      vertices: this.vertexCount,
      triangles: this.indexCount / 3,
    };

    this.gpuVertexByteOffset += vertexByteSize;
    this.gpuTxIndexByteOffset += txByteSize;
    this.gpuIndexByteOffset += indexByteSize;

    this.vertexCount = 0;
    this.indexCount = 0;
    return result;
  }

  dispose(): void {
    this.vertexBuffer?.destroy();
    this.indexBuffer?.destroy();
    this.txIndexBuffer?.destroy();
    this.vertexBuffer = null;
    this.indexBuffer = null;
    this.txIndexBuffer = null;
  }
}
