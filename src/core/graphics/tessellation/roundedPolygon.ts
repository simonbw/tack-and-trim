import { clamp } from "../../util/MathUtil";
import { tessellateFanPolygon, tessellateStrokePolygon } from "./polygon";
import { VertexSink } from "./VertexSink";

function getCornerSegments(offset: number): number {
  return clamp(Math.ceil(offset), 4, 12);
}

/**
 * Build the tessellated outline of a polygon with rounded (quadratic-Bézier)
 * corners. The original vertex acts as the Bézier control point; on-curve
 * anchors are offset inward along each adjacent edge by `radius`.
 */
export function buildRoundedPolygonOutline(
  vertices: ReadonlyArray<{ x: number; y: number }>,
  radius: number,
): [number, number][] {
  const n = vertices.length;
  if (n < 3) return vertices.map((v) => [v.x, v.y] as [number, number]);

  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const prev = vertices[(i - 1 + n) % n];
    const curr = vertices[i];
    const next = vertices[(i + 1) % n];

    const toPrevX = prev.x - curr.x;
    const toPrevY = prev.y - curr.y;
    const toNextX = next.x - curr.x;
    const toNextY = next.y - curr.y;
    const prevLen = Math.sqrt(toPrevX * toPrevX + toPrevY * toPrevY);
    const nextLen = Math.sqrt(toNextX * toNextX + toNextY * toNextY);

    const maxR = Math.min(prevLen, nextLen) / 2;
    const r = Math.min(radius, maxR);
    if (r <= 0.001) {
      out.push([curr.x, curr.y]);
      continue;
    }
    const startX = curr.x + (toPrevX / prevLen) * r;
    const startY = curr.y + (toPrevY / prevLen) * r;
    const endX = curr.x + (toNextX / nextLen) * r;
    const endY = curr.y + (toNextY / nextLen) * r;

    const segments = getCornerSegments(r);
    for (let j = 0; j <= segments; j++) {
      const t = j / segments;
      const mt = 1 - t;
      const mt2 = mt * mt;
      const t2 = t * t;
      out.push([
        mt2 * startX + 2 * mt * t * curr.x + t2 * endX,
        mt2 * startY + 2 * mt * t * curr.y + t2 * endY,
      ]);
    }
  }
  return out;
}

export function tessellateFillRoundedPolygon(
  sink: VertexSink,
  vertices: ReadonlyArray<{ x: number; y: number }>,
  radius: number,
  color: number,
  alpha: number,
  z: number,
): void {
  const rounded = buildRoundedPolygonOutline(vertices, radius);
  if (rounded.length < 3) return;
  tessellateFanPolygon(sink, rounded, color, alpha, z);
}

export function tessellateStrokeRoundedPolygon(
  sink: VertexSink,
  vertices: ReadonlyArray<{ x: number; y: number }>,
  radius: number,
  width: number,
  color: number,
  alpha: number,
  z: number,
): void {
  const rounded = buildRoundedPolygonOutline(vertices, radius);
  if (rounded.length < 2) return;
  tessellateStrokePolygon(
    sink,
    rounded.map(([x, y]) => ({ x, y })),
    width,
    color,
    alpha,
    z,
  );
}
