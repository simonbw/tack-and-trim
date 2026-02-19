export type Point = [number, number];

function perpendicularDistance(point: Point, lineStart: Point, lineEnd: Point): number {
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

function rdp(points: Point[], tolerance: number): Point[] {
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
    return [points[0], points[points.length - 1]];
  }

  const left = rdp(points.slice(0, splitIndex + 1), tolerance);
  const right = rdp(points.slice(splitIndex), tolerance);
  return left.slice(0, -1).concat(right);
}

export function simplifyPolyline(points: Point[], tolerance: number): Point[] {
  if (tolerance <= 0 || points.length < 3) {
    return points.slice();
  }
  return rdp(points, tolerance);
}

export function simplifyClosedRing(points: Point[], tolerance: number): Point[] {
  if (points.length < 4 || tolerance <= 0) {
    return points.slice();
  }

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
  const simplifiedOpen = rdp(open, tolerance);

  if (simplifiedOpen.length <= 2) {
    return points.slice();
  }

  const simplifiedRing = simplifiedOpen.slice(0, -1);
  return simplifiedRing.length >= 3 ? simplifiedRing : points.slice();
}

export function ringPerimeter(points: Point[]): number {
  if (points.length < 2) {
    return 0;
  }

  let length = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    length += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return length;
}
