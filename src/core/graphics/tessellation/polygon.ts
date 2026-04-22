import { V2d } from "../../Vector";
import { earClipTriangulate } from "../../util/Triangulate";
import { unpackColor } from "./color";
import { tessellateWorldPolyline } from "./polyline";
import { VertexSink, writeVertex } from "./VertexSink";

/**
 * Fill a simple (non-self-intersecting) polygon via ear-clip triangulation.
 * Handles both convex and concave polygons. No-op if triangulation fails.
 */
export function tessellateFillPolygon(
  sink: VertexSink,
  vertices: ReadonlyArray<{ x: number; y: number }>,
  color: number,
  alpha: number,
  lightAffected: number,
  z: number,
): void {
  if (vertices.length < 3) return;
  const indices = earClipTriangulate(vertices as V2d[]);
  if (!indices) return;

  const { r, g, b, a } = unpackColor(color, alpha);
  const { base, view } = sink.reserveVertices(vertices.length);
  for (let i = 0; i < vertices.length; i++) {
    writeVertex(
      view,
      i,
      vertices[i].x,
      vertices[i].y,
      r,
      g,
      b,
      a,
      lightAffected,
      z,
    );
  }

  const idxSlice = sink.reserveIndices(indices.length);
  for (let i = 0; i < indices.length; i++) idxSlice[i] = base + indices[i];
}

/**
 * Fan-triangulate a convex polygon (cheaper than ear-clip for the rounded
 * / smooth cases where the shape is known convex-ish by construction).
 */
export function tessellateFanPolygon(
  sink: VertexSink,
  vertices: ReadonlyArray<readonly [number, number]>,
  color: number,
  alpha: number,
  lightAffected: number,
  z: number,
): void {
  const n = vertices.length;
  if (n < 3) return;
  const { r, g, b, a } = unpackColor(color, alpha);
  const { base, view } = sink.reserveVertices(n);
  for (let i = 0; i < n; i++) {
    writeVertex(
      view,
      i,
      vertices[i][0],
      vertices[i][1],
      r,
      g,
      b,
      a,
      lightAffected,
      z,
    );
  }
  const idxSlice = sink.reserveIndices((n - 2) * 3);
  for (let i = 1; i < n - 1; i++) {
    idxSlice[(i - 1) * 3 + 0] = base;
    idxSlice[(i - 1) * 3 + 1] = base + i;
    idxSlice[(i - 1) * 3 + 2] = base + i + 1;
  }
}

/** Stroke a polygon (closed polyline with miter joins). */
export function tessellateStrokePolygon(
  sink: VertexSink,
  vertices: ReadonlyArray<{ x: number; y: number }>,
  width: number,
  color: number,
  alpha: number,
  lightAffected: number,
  z: number,
): void {
  if (vertices.length < 2) return;
  const points: [number, number][] = [];
  for (const v of vertices) points.push([v.x, v.y]);
  tessellateWorldPolyline(sink, points, z, width, color, alpha, lightAffected, {
    closed: true,
  });
}
