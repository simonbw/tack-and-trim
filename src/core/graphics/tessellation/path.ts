import { tessellateFanPolygon } from "./polygon";
import { tessellateWorldPolyline } from "./polyline";
import { VertexSink } from "./VertexSink";

/**
 * Fan-fill a path's accumulated point list. Expects the caller to have
 * already collapsed any near-coincident close-to-start duplicate.
 */
export function tessellatePathFill(
  sink: VertexSink,
  points: ReadonlyArray<{ x: number; y: number }>,
  color: number,
  alpha: number,
  z: number,
): void {
  if (points.length < 3) return;
  const arr: [number, number][] = [];
  for (const p of points) arr.push([p.x, p.y]);
  tessellateFanPolygon(sink, arr, color, alpha, z);
}

/**
 * Stroke a path's accumulated point list with miter joins.
 * When `closed` is true and the first/last points are nearly coincident,
 * the trailing duplicate is dropped to avoid spurious miter spikes.
 */
export function tessellatePathStroke(
  sink: VertexSink,
  points: ReadonlyArray<{ x: number; y: number }>,
  width: number,
  closed: boolean,
  color: number,
  alpha: number,
  z: number,
): void {
  let pts = points;
  if (closed && pts.length >= 3) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    const dx = last.x - first.x;
    const dy = last.y - first.y;
    if (dx * dx + dy * dy < 1e-6) pts = pts.slice(0, -1);
  }
  if (pts.length < 2) return;
  const arr: [number, number][] = [];
  for (const p of pts) arr.push([p.x, p.y]);
  tessellateWorldPolyline(sink, arr, z, width, color, alpha, { closed });
}
