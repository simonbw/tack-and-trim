/**
 * Consumer interface for primitive tessellators.
 *
 * The shape vertex layout carried through this sink is:
 *   position(2) + color(4) + z(1) = 7 floats = 28 bytes/vertex
 * Transform (modelCol0..2, zCoeffs, zDepth, tint) is applied per-instance
 * in the vertex shader via a storage buffer — no transform data is written
 * through this sink.
 *
 * Two concrete implementations exist:
 *   - ShapeBatch: writes into the live per-frame GPU batch. `base` is the
 *     running vertex count within that batch.
 *   - MeshBuilder: writes into a private growable buffer. `base` is the
 *     running vertex count within the mesh being built; the final mesh's
 *     indices are therefore 0-based relative to the mesh.
 *
 * Index semantics: callers write `base + localIdx` where `localIdx` is in
 * the primitive's own 0..n range. This keeps tessellators sink-agnostic —
 * the same code works for immediate-mode and retained-mode.
 */
export interface VertexSink {
  /**
   * Reserve n contiguous vertices. The returned view is a writable slice
   * of the backing Float32Array, length `n * VERTEX_STRIDE_FLOATS`.
   * Use writeVertex(view, i, ...) to populate, where i is in [0, n).
   */
  reserveVertices(n: number): { base: number; view: Float32Array };

  /**
   * Reserve n indices. Caller writes values in `[base, base + vertexCount)`
   * where `base` comes from a matching reserveVertices call and vertexCount
   * is the number of vertices in the primitive.
   */
  reserveIndices(n: number): Uint32Array;
}

/** Floats per shape vertex written through a VertexSink. */
export const VERTEX_STRIDE_FLOATS = 7;

/**
 * Write one vertex's 7 floats at slot `i` in the reserved view.
 */
export function writeVertex(
  view: Float32Array,
  i: number,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  a: number,
  z: number,
): void {
  const o = i * VERTEX_STRIDE_FLOATS;
  view[o] = x;
  view[o + 1] = y;
  view[o + 2] = r;
  view[o + 3] = g;
  view[o + 4] = b;
  view[o + 5] = a;
  view[o + 6] = z;
}
