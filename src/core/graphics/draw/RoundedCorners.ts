import { clamp } from "../../util/MathUtil";
import { V, V2d } from "../../Vector";

// Number of segments for a Bézier corner based on offset
function getCornerSegments(offset: number): number {
  return clamp(Math.ceil(offset), 4, 12);
}

/**
 * Build vertices for a rounded polygon using quadratic Bézier corners.
 * Returns the tessellated vertices ready for rendering.
 */
function buildRoundedPolygonVertices(
  vertices: readonly V2d[],
  radius: number,
): readonly V2d[] {
  if (vertices.length < 3) return vertices; // Not enough vertices to form a polygon

  const result: V2d[] = [];

  for (let i = 0; i < vertices.length; i++) {
    const prev = vertices[(i - 1 + vertices.length) % vertices.length];
    const curr = vertices[i];
    const next = vertices[(i + 1) % vertices.length];

    // Edge vectors
    const toPrev = prev.sub(curr);
    const toNext = next.sub(curr);
    const prevLen = toPrev.magnitude;
    const nextLen = toNext.magnitude;

    // Clamp radius to half the shortest adjacent edge
    const maxRadius = Math.min(prevLen, nextLen) / 2;
    const r = Math.min(radius, maxRadius);

    if (r <= 0.001) {
      // No rounding needed
      result.push(curr.clone());
      continue;
    }

    // Offset points along edges
    const pStart = curr.add(toPrev.normalize().imul(r));
    const pEnd = curr.add(toNext.normalize().imul(r));

    // Generate quadratic Bézier curve with curr as control point
    const segments = getCornerSegments(r);
    for (let j = 0; j <= segments; j++) {
      const t = j / segments;
      const t2 = t * t;
      const mt = 1 - t;
      const mt2 = mt * mt;

      // B(t) = (1-t)²P0 + 2(1-t)tP1 + t²P2
      const px = mt2 * pStart.x + 2 * mt * t * curr.x + t2 * pEnd.x;
      const py = mt2 * pStart.y + 2 * mt * t * curr.y + t2 * pEnd.y;
      result.push(V(px, py));
    }
  }

  return result;
}

export { buildRoundedPolygonVertices };
