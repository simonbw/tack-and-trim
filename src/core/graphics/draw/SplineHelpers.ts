import { V, V2d } from "../../Vector";

/**
 * Tessellate a Catmull-Rom spline through the given points.
 * @param points Control points the spline passes through
 * @param closed Whether to close the curve back to the start
 * @param tension Curve tightness (0-1, default 0.5)
 * @param segmentsPerSpan Segments per span between control points
 */
function buildCatmullRomSpline(
  points: V2d[],
  closed: boolean,
  tension: number = 0.5,
  segmentsPerSpan: number = 8,
): V2d[] {
  if (points.length < 2) return points.slice();

  const result: V2d[] = [];
  const n = points.length;

  // For Catmull-Rom, we need 4 points per segment: P0, P1, P2, P3
  // The curve is drawn between P1 and P2
  const segmentCount = closed ? n : n - 1;

  for (let i = 0; i < segmentCount; i++) {
    // Get the 4 control points for this segment
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];

    // For open splines, handle endpoints specially
    let actualP0 = p0;
    let actualP3 = p3;
    if (!closed) {
      if (i === 0) {
        // First segment: extrapolate P0
        actualP0 = V(2 * p1.x - p2.x, 2 * p1.y - p2.y);
      }
      if (i === n - 2) {
        // Last segment: extrapolate P3
        actualP3 = V(2 * p2.x - p1.x, 2 * p2.y - p1.y);
      }
    }

    // Compute tangents with tension
    const m1x = tension * (p2.x - actualP0.x);
    const m1y = tension * (p2.y - actualP0.y);
    const m2x = tension * (actualP3.x - p1.x);
    const m2y = tension * (actualP3.y - p1.y);

    // Generate points along this segment
    for (let j = 0; j < segmentsPerSpan; j++) {
      const t = j / segmentsPerSpan;
      const t2 = t * t;
      const t3 = t2 * t;

      // Hermite basis functions
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;

      const px = h00 * p1.x + h10 * m1x + h01 * p2.x + h11 * m2x;
      const py = h00 * p1.y + h10 * m1y + h01 * p2.y + h11 * m2y;
      result.push(V(px, py));
    }
  }

  // Add the final point
  if (closed) {
    result.push(points[0].clone());
  } else {
    result.push(points[n - 1].clone());
  }

  return result;
}

export { buildCatmullRomSpline };
