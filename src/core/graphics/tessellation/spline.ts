import { tessellateWorldPolyline } from "./polyline";
import { buildCatmullRomOutline } from "./smoothPolygon";
import { VertexSink } from "./VertexSink";

/**
 * Tessellate an open Catmull-Rom spline as a world-width stroke.
 */
export function tessellateSpline(
  sink: VertexSink,
  vertices: ReadonlyArray<{ x: number; y: number }>,
  tension: number,
  width: number,
  color: number,
  alpha: number,
  z: number,
): void {
  const spline = buildCatmullRomOutline(vertices, false, tension);
  if (spline.length < 2) return;
  tessellateWorldPolyline(sink, spline, z, width, color, alpha, {
    closed: false,
  });
}
