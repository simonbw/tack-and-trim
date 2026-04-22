import { unpackColor } from "./color";
import { VertexSink, writeVertex } from "./VertexSink";

/**
 * World-space filled circle as a triangle fan around (cx, cy).
 * Emits (segments + 2) vertices: center + (segments + 1) rim vertices.
 */
export function tessellateCircle(
  sink: VertexSink,
  cx: number,
  cy: number,
  radius: number,
  segments: number,
  color: number,
  alpha: number,
  lightAffected: number,
  z: number,
): void {
  const { r, g, b, a } = unpackColor(color, alpha);
  const { base, view } = sink.reserveVertices(segments + 2);

  writeVertex(view, 0, cx, cy, r, g, b, a, lightAffected, z);
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    writeVertex(
      view,
      i + 1,
      cx + Math.cos(angle) * radius,
      cy + Math.sin(angle) * radius,
      r,
      g,
      b,
      a,
      lightAffected,
      z,
    );
  }

  const idx = sink.reserveIndices(segments * 3);
  for (let i = 0; i < segments; i++) {
    idx[i * 3] = base;
    idx[i * 3 + 1] = base + 1 + i;
    idx[i * 3 + 2] = base + 1 + ((i + 1) % (segments + 1));
  }
}

/**
 * Variant that reuses pre-computed unit-circle cos/sin tables (common when
 * Draw batches many circles with the same segment count).
 */
export function tessellateCircleFromTable(
  sink: VertexSink,
  cx: number,
  cy: number,
  radius: number,
  cos: Float32Array,
  sin: Float32Array,
  color: number,
  alpha: number,
  lightAffected: number,
  z: number,
): void {
  const segments = cos.length - 1;
  const { r, g, b, a } = unpackColor(color, alpha);
  const { base, view } = sink.reserveVertices(segments + 2);

  writeVertex(view, 0, cx, cy, r, g, b, a, lightAffected, z);
  for (let i = 0; i <= segments; i++) {
    writeVertex(
      view,
      i + 1,
      cx + cos[i] * radius,
      cy + sin[i] * radius,
      r,
      g,
      b,
      a,
      lightAffected,
      z,
    );
  }

  const idx = sink.reserveIndices(segments * 3);
  for (let i = 0; i < segments; i++) {
    idx[i * 3] = base;
    idx[i * 3 + 1] = base + 1 + i;
    idx[i * 3 + 2] = base + 1 + ((i + 1) % (segments + 1));
  }
}
