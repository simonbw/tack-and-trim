import { VERTEX_STRIDE_FLOATS } from "./tessellation/VertexSink";

/**
 * Mutable retained-mode mesh with fixed capacity.
 *
 * For topology-stable, per-frame-animated geometry (e.g. a cloth sail
 * whose vertex positions update each frame but whose triangle list doesn't).
 * Caller writes directly into `vertexData` and `indexData`, updating
 * `vertexCount` / `indexCount` before submission.
 *
 * Submission behaviour is identical to `CachedMesh`; the mutability is a
 * caller contract, not a runtime distinction.
 */
export class DynamicMesh {
  readonly vertexData: Float32Array;
  readonly indexData: Uint32Array;
  vertexCount = 0;
  indexCount = 0;

  constructor(
    readonly vertexCapacity: number,
    readonly indexCapacity: number,
  ) {
    this.vertexData = new Float32Array(vertexCapacity * VERTEX_STRIDE_FLOATS);
    this.indexData = new Uint32Array(indexCapacity);
  }

  reset(): void {
    this.vertexCount = 0;
    this.indexCount = 0;
  }
}
