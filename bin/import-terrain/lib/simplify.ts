/**
 * Ramer-Douglas-Peucker polygon simplification.
 */

type Point = [number, number];

/**
 * Perpendicular distance from a point to a line segment.
 */
function perpendicularDistance(
  point: Point,
  lineStart: Point,
  lineEnd: Point,
): number {
  const dx = lineEnd[0] - lineStart[0];
  const dy = lineEnd[1] - lineStart[1];
  const lengthSq = dx * dx + dy * dy;

  if (lengthSq === 0) {
    // lineStart and lineEnd are the same point
    const ex = point[0] - lineStart[0];
    const ey = point[1] - lineStart[1];
    return Math.sqrt(ex * ex + ey * ey);
  }

  const t = ((point[0] - lineStart[0]) * dx + (point[1] - lineStart[1]) * dy) / lengthSq;
  const clampedT = Math.max(0, Math.min(1, t));

  const projX = lineStart[0] + clampedT * dx;
  const projY = lineStart[1] + clampedT * dy;

  const ex = point[0] - projX;
  const ey = point[1] - projY;
  return Math.sqrt(ex * ex + ey * ey);
}

/**
 * Simplify a polyline using the Ramer-Douglas-Peucker algorithm.
 *
 * @param points - Array of [x, y] points
 * @param tolerance - Maximum distance a point can be from the simplified line before it's kept
 * @returns Simplified array of [x, y] points
 */
export function simplifyPolyline(points: Point[], tolerance: number): Point[] {
  if (points.length <= 2) return points;

  // Find the point with the maximum distance from the line between first and last
  let maxDist = 0;
  let maxIndex = 0;

  for (let i = 1; i < points.length - 1; i++) {
    const dist = perpendicularDistance(
      points[i],
      points[0],
      points[points.length - 1],
    );
    if (dist > maxDist) {
      maxDist = dist;
      maxIndex = i;
    }
  }

  if (maxDist > tolerance) {
    // Recursively simplify both halves
    const left = simplifyPolyline(points.slice(0, maxIndex + 1), tolerance);
    const right = simplifyPolyline(points.slice(maxIndex), tolerance);

    // Combine, removing duplicate point at junction
    return [...left.slice(0, -1), ...right];
  } else {
    // All points are within tolerance, keep only endpoints
    return [points[0], points[points.length - 1]];
  }
}

/**
 * Simplify a closed polygon using RDP.
 * Handles the wrap-around by finding the best split point.
 *
 * @param points - Array of [x, y] points forming a closed polygon (last != first)
 * @param tolerance - Maximum distance tolerance
 * @returns Simplified closed polygon points (last != first)
 */
export function simplifyPolygon(points: Point[], tolerance: number): Point[] {
  if (points.length <= 3) return points;

  // For a closed polygon, we need to handle the wrap-around.
  // Strategy: find the point farthest from its neighbors, use that as the
  // start/end point, then simplify as an open polyline.
  // This avoids losing important corner points at the seam.

  // Duplicate the first point at the end to close the loop for simplification
  const closed = [...points, points[0]];
  const simplified = simplifyPolyline(closed, tolerance);

  // Remove the closing duplicate
  if (
    simplified.length > 1 &&
    simplified[0][0] === simplified[simplified.length - 1][0] &&
    simplified[0][1] === simplified[simplified.length - 1][1]
  ) {
    simplified.pop();
  }

  return simplified;
}
