/**
 * Geometry utilities.
 *
 * Provides common geometric algorithms like point-in-polygon tests.
 */

import { V2d } from "../Vector";

/**
 * Ray casting algorithm for point-in-polygon test.
 *
 * Tests whether a point lies inside a polygon by casting a ray
 * to the right and counting edge crossings.
 *
 * @param point - The point to test
 * @param polygon - Array of vertices forming a closed polygon
 * @returns True if the point is inside the polygon
 */
export function pointInPolygon(point: V2d, polygon: readonly V2d[]): boolean {
  const n = polygon.length;
  if (n < 3) return false;

  let inside = false;

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x,
      yi = polygon[i].y;
    const xj = polygon[j].x,
      yj = polygon[j].y;

    if (
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }

  return inside;
}
