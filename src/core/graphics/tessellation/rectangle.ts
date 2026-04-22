import { unpackColor } from "./color";
import { VertexSink, writeVertex } from "./VertexSink";

/** Axis-aligned filled rectangle (2 triangles). */
export function tessellateRect(
  sink: VertexSink,
  x: number,
  y: number,
  w: number,
  h: number,
  color: number,
  alpha: number,
  lightAffected: number,
  z: number,
): void {
  const { r, g, b, a } = unpackColor(color, alpha);
  const { base, view } = sink.reserveVertices(4);
  writeVertex(view, 0, x, y, r, g, b, a, lightAffected, z);
  writeVertex(view, 1, x + w, y, r, g, b, a, lightAffected, z);
  writeVertex(view, 2, x + w, y + h, r, g, b, a, lightAffected, z);
  writeVertex(view, 3, x, y + h, r, g, b, a, lightAffected, z);

  const idx = sink.reserveIndices(6);
  idx[0] = base;
  idx[1] = base + 1;
  idx[2] = base + 2;
  idx[3] = base;
  idx[4] = base + 2;
  idx[5] = base + 3;
}

/**
 * Rotated filled rectangle (2 triangles). The rectangle is specified by
 * its local-space corner (offsetX, offsetY) + size (w, h), rotated around
 * (cx, cy) by `angle`.
 */
export function tessellateRotatedRect(
  sink: VertexSink,
  cx: number,
  cy: number,
  offsetX: number,
  offsetY: number,
  w: number,
  h: number,
  angle: number,
  color: number,
  alpha: number,
  lightAffected: number,
  z: number,
): void {
  const { r, g, b, a } = unpackColor(color, alpha);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  const { base, view } = sink.reserveVertices(4);
  const corners: [number, number][] = [
    [offsetX, offsetY],
    [offsetX + w, offsetY],
    [offsetX + w, offsetY + h],
    [offsetX, offsetY + h],
  ];
  for (let i = 0; i < 4; i++) {
    const [lx, ly] = corners[i];
    writeVertex(
      view,
      i,
      cx + cos * lx - sin * ly,
      cy + sin * lx + cos * ly,
      r,
      g,
      b,
      a,
      lightAffected,
      z,
    );
  }

  const idx = sink.reserveIndices(6);
  idx[0] = base;
  idx[1] = base + 1;
  idx[2] = base + 2;
  idx[3] = base;
  idx[4] = base + 2;
  idx[5] = base + 3;
}
