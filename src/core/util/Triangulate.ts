/**
 * Polygon triangulation utilities.
 *
 * Provides ear clipping algorithm for triangulating simple (non-self-intersecting)
 * polygons. Works with both convex and concave polygons.
 */

import { ReadonlyV2d } from "../Vector";

/**
 * Compute the signed area of a polygon (positive = CCW, negative = CW).
 */
export function signedPolygonArea(points: readonly ReadonlyV2d[]): number {
  let area = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += points[i].x * points[j].y;
    area -= points[j].x * points[i].y;
  }
  return area / 2;
}

/**
 * Check if point C is to the left of line AB.
 */
function isLeftOf(a: ReadonlyV2d, b: ReadonlyV2d, c: ReadonlyV2d): boolean {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) > 0;
}

/**
 * Check if a point is strictly inside a triangle (not on edges).
 * Uses cross product signs - all three must have the same sign for point to be inside.
 */
function pointStrictlyInTriangle(
  p: ReadonlyV2d,
  a: ReadonlyV2d,
  b: ReadonlyV2d,
  c: ReadonlyV2d,
): boolean {
  const d1 = (p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x);
  const d2 = (p.x - b.x) * (c.y - b.y) - (p.y - b.y) * (c.x - b.x);
  const d3 = (p.x - c.x) * (a.y - c.y) - (p.y - c.y) * (a.x - c.x);

  const eps = 1e-6;
  const allPositive = d1 > eps && d2 > eps && d3 > eps;
  const allNegative = d1 < -eps && d2 < -eps && d3 < -eps;

  return allPositive || allNegative;
}

/**
 * Check if vertex at index i is an ear (can be clipped).
 */
function isEar(
  polygon: readonly number[],
  points: readonly ReadonlyV2d[],
  i: number,
  isCCW: boolean,
): boolean {
  const n = polygon.length;
  const prevIdx = polygon[(i - 1 + n) % n];
  const currIdx = polygon[i];
  const nextIdx = polygon[(i + 1) % n];

  const prev = points[prevIdx];
  const curr = points[currIdx];
  const next = points[nextIdx];

  // For CCW polygon, convex vertices "bulge out" to the RIGHT of chord prev->next
  // For CW polygon, convex vertices "bulge out" to the LEFT of chord prev->next
  const isConvex = isCCW
    ? !isLeftOf(prev, next, curr)
    : isLeftOf(prev, next, curr);

  if (!isConvex) {
    return false;
  }

  for (let j = 0; j < n; j++) {
    if (j === (i - 1 + n) % n || j === i || j === (i + 1) % n) {
      continue;
    }
    const testIdx = polygon[j];
    if (pointStrictlyInTriangle(points[testIdx], prev, curr, next)) {
      return false;
    }
  }

  return true;
}

/**
 * Triangulate a simple polygon using ear clipping algorithm.
 *
 * Works for both convex and concave polygons. Does NOT work for
 * self-intersecting polygons - those need to be fixed first.
 *
 * @param points - Array of polygon vertices in order (CCW or CW)
 * @returns Array of triangle indices (length is multiple of 3), or null if triangulation fails
 */
export function earClipTriangulate(
  points: readonly ReadonlyV2d[],
): number[] | null {
  const n = points.length;
  if (n < 3) return null;
  if (n === 3) return [0, 1, 2];

  const area = signedPolygonArea(points);

  // Degenerate polygon with zero area
  if (Math.abs(area) < 1e-10) return null;

  const isCCW = area > 0;

  const polygon: number[] = [];
  for (let i = 0; i < n; i++) {
    polygon.push(i);
  }

  const triangles: number[] = [];
  let safety = n * n;

  while (polygon.length > 3 && safety > 0) {
    safety--;
    let earFound = false;

    for (let i = 0; i < polygon.length; i++) {
      if (isEar(polygon, points, i, isCCW)) {
        const prevI = (i - 1 + polygon.length) % polygon.length;
        const nextI = (i + 1) % polygon.length;

        triangles.push(polygon[prevI], polygon[i], polygon[nextI]);
        polygon.splice(i, 1);
        earFound = true;
        break;
      }
    }

    if (!earFound) {
      // Triangulation failed - likely self-intersecting or degenerate polygon
      return null;
    }
  }

  if (polygon.length === 3) {
    triangles.push(polygon[0], polygon[1], polygon[2]);
  }

  return triangles;
}
