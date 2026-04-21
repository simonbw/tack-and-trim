import { VERTEX_STRIDE_FLOATS } from "./tessellation/VertexSink";

/**
 * Immutable retained-mode shape mesh.
 *
 * Vertex layout matches the VertexSink contract: 7 floats/vertex
 * (position x,y + color r,g,b,a + z). Indices are 0-based relative to
 * this mesh; they get rebased (offset-added) at submission time.
 *
 * No GPU resources are held — submission is a memcpy into the active
 * batch.
 */
export class CachedMesh {
  constructor(
    readonly vertexData: Float32Array,
    readonly indexData: Uint32Array,
    readonly vertexCount: number,
    readonly indexCount: number,
  ) {}

  /** Byte-size estimate for budgeting. */
  get byteSize(): number {
    return this.vertexCount * VERTEX_STRIDE_FLOATS * 4 + this.indexCount * 4;
  }
}
