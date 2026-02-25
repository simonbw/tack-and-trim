/**
 * Modified Ramer-Douglas-Peucker simplification that checks a spatial index
 * before collapsing segments, preventing intersections with already-finalized
 * contours.
 */

import type { Point } from "./simplify";
import type { SegmentIndex } from "./segment-index";

function perpendicularDistance(
  point: Point,
  lineStart: Point,
  lineEnd: Point,
): number {
  const [x, y] = point;
  const [x1, y1] = lineStart;
  const [x2, y2] = lineEnd;

  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    return Math.hypot(x - x1, y - y1);
  }

  const t = ((x - x1) * dx + (y - y1) * dy) / lengthSquared;
  const clampedT = Math.max(0, Math.min(1, t));
  const projX = x1 + clampedT * dx;
  const projY = y1 + clampedT * dy;
  return Math.hypot(x - projX, y - projY);
}

function constrainedRdp(
  points: Point[],
  tolerance: number,
  contourIndex: number,
  segmentIndex: SegmentIndex,
): Point[] {
  if (points.length <= 2) {
    return points.slice();
  }

  let maxDistance = 0;
  let splitIndex = 0;

  for (let i = 1; i < points.length - 1; i++) {
    const distance = perpendicularDistance(
      points[i],
      points[0],
      points[points.length - 1],
    );
    if (distance > maxDistance) {
      maxDistance = distance;
      splitIndex = i;
    }
  }

  if (maxDistance <= tolerance) {
    // Check if collapsing to a single segment would intersect existing contours
    const start = points[0];
    const end = points[points.length - 1];
    if (
      !segmentIndex.segmentIntersectsAny(
        start[0],
        start[1],
        end[0],
        end[1],
        contourIndex,
      )
    ) {
      return [start, end]; // safe collapse
    }
    // Intersection detected — fall through to split and keep detail
  }

  const left = constrainedRdp(
    points.slice(0, splitIndex + 1),
    tolerance,
    contourIndex,
    segmentIndex,
  );
  const right = constrainedRdp(
    points.slice(splitIndex),
    tolerance,
    contourIndex,
    segmentIndex,
  );
  return left.slice(0, -1).concat(right);
}

/**
 * Simplify a closed ring using constrained RDP.
 * Same anchor-rotation logic as simplifyClosedRing in simplify.ts.
 */
export function constrainedSimplifyClosedRing(
  points: Point[],
  tolerance: number,
  contourIndex: number,
  segmentIndex: SegmentIndex,
): Point[] {
  if (points.length < 4 || tolerance <= 0) {
    return points.slice();
  }

  // Find anchor point (rightmost x) — same as simplify.ts
  let anchorIndex = 0;
  let maxX = points[0][0];
  for (let i = 1; i < points.length; i++) {
    if (points[i][0] > maxX) {
      maxX = points[i][0];
      anchorIndex = i;
    }
  }

  const rotated: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    rotated.push(points[(anchorIndex + i) % points.length]);
  }

  const open = rotated.concat([rotated[0]]);
  const simplifiedOpen = constrainedRdp(
    open,
    tolerance,
    contourIndex,
    segmentIndex,
  );

  if (simplifiedOpen.length <= 2) {
    return points.slice();
  }

  const simplifiedRing = simplifiedOpen.slice(0, -1);
  return simplifiedRing.length >= 3 ? simplifiedRing : points.slice();
}
