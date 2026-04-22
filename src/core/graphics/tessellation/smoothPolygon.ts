import { V2d } from "../../Vector";
import { earClipTriangulate } from "../../util/Triangulate";
import { unpackColor } from "./color";
import { tessellateStrokePolygon } from "./polygon";
import { VertexSink, writeVertex } from "./VertexSink";

/**
 * Sample a Catmull-Rom spline through the given control points.
 * Closed=true wraps back to the start; closed=false uses linear extrapolation
 * at the endpoints.
 */
export function buildCatmullRomOutline(
  points: ReadonlyArray<{ x: number; y: number }>,
  closed: boolean,
  tension: number = 0.5,
  segmentsPerSpan: number = 8,
): [number, number][] {
  const n = points.length;
  if (n < 2) return points.map((p) => [p.x, p.y] as [number, number]);

  const result: [number, number][] = [];
  const segmentCount = closed ? n : n - 1;

  for (let i = 0; i < segmentCount; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];

    let actualP0X = p0.x;
    let actualP0Y = p0.y;
    let actualP3X = p3.x;
    let actualP3Y = p3.y;
    if (!closed) {
      if (i === 0) {
        actualP0X = 2 * p1.x - p2.x;
        actualP0Y = 2 * p1.y - p2.y;
      }
      if (i === n - 2) {
        actualP3X = 2 * p2.x - p1.x;
        actualP3Y = 2 * p2.y - p1.y;
      }
    }

    const m1x = tension * (p2.x - actualP0X);
    const m1y = tension * (p2.y - actualP0Y);
    const m2x = tension * (actualP3X - p1.x);
    const m2y = tension * (actualP3Y - p1.y);

    for (let j = 0; j < segmentsPerSpan; j++) {
      const t = j / segmentsPerSpan;
      const t2 = t * t;
      const t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      result.push([
        h00 * p1.x + h10 * m1x + h01 * p2.x + h11 * m2x,
        h00 * p1.y + h10 * m1y + h01 * p2.y + h11 * m2y,
      ]);
    }
  }

  if (closed) {
    result.push([points[0].x, points[0].y]);
  } else {
    result.push([points[n - 1].x, points[n - 1].y]);
  }
  return result;
}

export function tessellateFillSmoothPolygon(
  sink: VertexSink,
  vertices: ReadonlyArray<{ x: number; y: number }>,
  tension: number,
  color: number,
  alpha: number,
  lightAffected: number,
  z: number,
): void {
  const spline = buildCatmullRomOutline(vertices, true, tension);
  if (spline.length < 3) return;

  // Ear-clip requires {x, y} objects; allocate a lightweight adapter.
  const asV2d: V2d[] = spline.map(([x, y]) => ({ x, y }) as V2d);
  const indices = earClipTriangulate(asV2d);
  if (!indices) return;

  const { r, g, b, a } = unpackColor(color, alpha);
  const { base, view } = sink.reserveVertices(spline.length);
  for (let i = 0; i < spline.length; i++) {
    writeVertex(
      view,
      i,
      spline[i][0],
      spline[i][1],
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

export function tessellateStrokeSmoothPolygon(
  sink: VertexSink,
  vertices: ReadonlyArray<{ x: number; y: number }>,
  tension: number,
  width: number,
  color: number,
  alpha: number,
  lightAffected: number,
  z: number,
): void {
  const spline = buildCatmullRomOutline(vertices, true, tension);
  if (spline.length < 2) return;
  tessellateStrokePolygon(
    sink,
    spline.map(([x, y]) => ({ x, y })),
    width,
    color,
    alpha,
    lightAffected,
    z,
  );
}
