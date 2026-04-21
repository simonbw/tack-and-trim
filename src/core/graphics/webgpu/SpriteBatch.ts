/**
 * CPU-side batch for textured sprite vertices.
 *
 * Layout per vertex: position(2) + texCoord(2) + color(4) + z(1) = 9 floats
 * = 36 bytes. A parallel Uint32 stream carries transformIndex. Indices are
 * Uint32.
 *
 * Sprites don't use the generic VertexSink contract; `drawImage` writes the
 * vertex pairs directly.
 */
export const SPRITE_VERTEX_FLOATS = 9;

export const SPRITE_MAX_VERTICES = 262_144;
// Every sprite is 4 verts → 6 indices, so indices = verts × 1.5.
export const SPRITE_MAX_INDICES = (SPRITE_MAX_VERTICES / 4) * 6;

const GPU_BUFFER_FLUSH_CAPACITY = 4;

export class SpriteBatch {
  readonly vertexData: Float32Array;
  readonly indexData: Uint32Array;
  readonly txIndexData: Uint32Array;

  vertexCount = 0;
  indexCount = 0;

  currentTransformIndex = 0;

  vertexBuffer: GPUBuffer | null = null;
  indexBuffer: GPUBuffer | null = null;
  txIndexBuffer: GPUBuffer | null = null;

  gpuVertexByteOffset = 0;
  gpuIndexByteOffset = 0;
  gpuTxIndexByteOffset = 0;

  constructor(
    readonly maxVertices: number = SPRITE_MAX_VERTICES,
    readonly maxIndices: number = SPRITE_MAX_INDICES,
  ) {
    this.vertexData = new Float32Array(maxVertices * SPRITE_VERTEX_FLOATS);
    this.txIndexData = new Uint32Array(maxVertices);
    this.indexData = new Uint32Array(maxIndices);
  }

  createGpuBuffers(device: GPUDevice): void {
    if (this.vertexBuffer) return;
    this.vertexBuffer = device.createBuffer({
      size: this.vertexData.byteLength * GPU_BUFFER_FLUSH_CAPACITY,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      label: "Sprite Vertex Buffer",
    });
    this.txIndexBuffer = device.createBuffer({
      size: this.txIndexData.byteLength * GPU_BUFFER_FLUSH_CAPACITY,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      label: "Sprite TransformIndex Buffer",
    });
    this.indexBuffer = device.createBuffer({
      size: this.indexData.byteLength * GPU_BUFFER_FLUSH_CAPACITY,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      label: "Sprite Index Buffer",
    });
  }

  resetFrameOffsets(): void {
    this.gpuVertexByteOffset = 0;
    this.gpuIndexByteOffset = 0;
    this.gpuTxIndexByteOffset = 0;
  }

  /** Write a single sprite quad (4 verts + 6 indices) using the current transform index. */
  writeQuad(
    corners: ReadonlyArray<readonly [number, number]>,
    uvs: ReadonlyArray<readonly [number, number]>,
    r: number,
    g: number,
    b: number,
    a: number,
    z: number,
  ): void {
    const base = this.vertexCount;
    const tx = this.currentTransformIndex;
    for (let i = 0; i < 4; i++) {
      const o = (base + i) * SPRITE_VERTEX_FLOATS;
      this.vertexData[o + 0] = corners[i][0];
      this.vertexData[o + 1] = corners[i][1];
      this.vertexData[o + 2] = uvs[i][0];
      this.vertexData[o + 3] = uvs[i][1];
      this.vertexData[o + 4] = r;
      this.vertexData[o + 5] = g;
      this.vertexData[o + 6] = b;
      this.vertexData[o + 7] = a;
      this.vertexData[o + 8] = z;
      this.txIndexData[base + i] = tx;
    }
    this.vertexCount += 4;

    const idx = this.indexCount;
    this.indexData[idx + 0] = base + 0;
    this.indexData[idx + 1] = base + 1;
    this.indexData[idx + 2] = base + 2;
    this.indexData[idx + 3] = base + 0;
    this.indexData[idx + 4] = base + 2;
    this.indexData[idx + 5] = base + 3;
    this.indexCount += 6;
  }

  flush(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    pipeline: GPURenderPipeline,
    uniformBindGroup: GPUBindGroup,
    textureBindGroup: GPUBindGroup,
  ): { vertices: number; triangles: number } {
    if (
      this.indexCount === 0 ||
      !this.vertexBuffer ||
      !this.indexBuffer ||
      !this.txIndexBuffer
    ) {
      return { vertices: 0, triangles: 0 };
    }

    const vertexByteSize = this.vertexCount * SPRITE_VERTEX_FLOATS * 4;
    const txByteSize = this.vertexCount * 4;
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
    pass.setBindGroup(0, uniformBindGroup);
    pass.setBindGroup(1, textureBindGroup);
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
