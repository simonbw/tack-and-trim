import type { Point } from "./simplify";

export interface ScalarGrid {
  width: number;
  height: number;
  values: Float64Array;
  nodataMask?: Uint8Array;
}

interface Segment {
  a: Point;
  b: Point;
}

interface CellPoint {
  x: number;
  y: number;
  value: number;
  isNoData: boolean;
}

function gridIndex(width: number, x: number, y: number): number {
  return y * width + x;
}

function cellPoint(grid: ScalarGrid, x: number, y: number): CellPoint {
  const idx = gridIndex(grid.width, x, y);
  return {
    x,
    y,
    value: grid.values[idx],
    isNoData: grid.nodataMask ? grid.nodataMask[idx] !== 0 : false,
  };
}

function interpolate(a: CellPoint, b: CellPoint, level: number): Point {
  const delta = b.value - a.value;
  if (Math.abs(delta) < 1e-12) {
    return [(a.x + b.x) * 0.5, (a.y + b.y) * 0.5];
  }

  const t = (level - a.value) / delta;
  return [a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t];
}

function caseSegments(corners: CellPoint[], level: number): Segment[] {
  const [tl, tr, br, bl] = corners;

  if (tl.isNoData || tr.isNoData || br.isNoData || bl.isNoData) {
    return [];
  }

  const above = [tl.value >= level, tr.value >= level, br.value >= level, bl.value >= level];
  const mask =
    (above[0] ? 8 : 0) |
    (above[1] ? 4 : 0) |
    (above[2] ? 2 : 0) |
    (above[3] ? 1 : 0);

  if (mask === 0 || mask === 15) {
    return [];
  }

  const edgeTop = interpolate(tl, tr, level);
  const edgeRight = interpolate(tr, br, level);
  const edgeBottom = interpolate(bl, br, level);
  const edgeLeft = interpolate(tl, bl, level);

  switch (mask) {
    case 1:
    case 14:
      return [{ a: edgeLeft, b: edgeBottom }];
    case 2:
    case 13:
      return [{ a: edgeBottom, b: edgeRight }];
    case 3:
    case 12:
      return [{ a: edgeLeft, b: edgeRight }];
    case 4:
    case 11:
      return [{ a: edgeTop, b: edgeRight }];
    case 5: {
      const centerValue = (tl.value + tr.value + br.value + bl.value) * 0.25;
      if (centerValue >= level) {
        return [
          { a: edgeTop, b: edgeLeft },
          { a: edgeRight, b: edgeBottom },
        ];
      }
      return [
        { a: edgeTop, b: edgeRight },
        { a: edgeLeft, b: edgeBottom },
      ];
    }
    case 6:
    case 9:
      return [{ a: edgeTop, b: edgeBottom }];
    case 7:
    case 8:
      return [{ a: edgeTop, b: edgeLeft }];
    case 10: {
      const centerValue = (tl.value + tr.value + br.value + bl.value) * 0.25;
      if (centerValue >= level) {
        return [
          { a: edgeTop, b: edgeRight },
          { a: edgeLeft, b: edgeBottom },
        ];
      }
      return [
        { a: edgeTop, b: edgeLeft },
        { a: edgeRight, b: edgeBottom },
      ];
    }
    default:
      return [];
  }
}

function pointKey(point: Point): string {
  return `${point[0].toFixed(6)},${point[1].toFixed(6)}`;
}

function signedArea(points: Point[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area * 0.5;
}

function buildClosedRings(segments: Segment[]): Point[][] {
  if (segments.length === 0) {
    return [];
  }

  const adjacency = new Map<string, Array<{ key: string; point: Point }>>();
  const pointByKey = new Map<string, Point>();

  const addEdge = (from: Point, to: Point) => {
    const fromKey = pointKey(from);
    const toKey = pointKey(to);

    pointByKey.set(fromKey, from);
    pointByKey.set(toKey, to);

    const list = adjacency.get(fromKey) ?? [];
    list.push({ key: toKey, point: to });
    adjacency.set(fromKey, list);
  };

  for (const segment of segments) {
    addEdge(segment.a, segment.b);
    addEdge(segment.b, segment.a);
  }

  const consumed = new Set<string>();
  const rings: Point[][] = [];

  const edgeId = (a: string, b: string) => `${a}|${b}`;

  for (const [startKey, neighbors] of adjacency.entries()) {
    for (const neighbor of neighbors) {
      const seedEdge = edgeId(startKey, neighbor.key);
      if (consumed.has(seedEdge)) {
        continue;
      }

      const ring: Point[] = [];
      let prevKey: string | null = null;
      let currKey = startKey;

      for (let i = 0; i < segments.length + 8; i++) {
        const currPoint = pointByKey.get(currKey);
        if (!currPoint) {
          break;
        }
        ring.push(currPoint);

        const nextOptions = adjacency.get(currKey) ?? [];
        let next = nextOptions.find((option) => option.key !== prevKey);
        if (!next) {
          next = nextOptions[0];
        }

        if (!next) {
          break;
        }

        consumed.add(edgeId(currKey, next.key));

        prevKey = currKey;
        currKey = next.key;

        if (currKey === startKey) {
          if (ring.length >= 3) {
            if (signedArea(ring) < 0) {
              ring.reverse();
            }
            rings.push(ring);
          }
          break;
        }
      }
    }
  }

  return rings;
}

export function extractContours(grid: ScalarGrid, level: number): Point[][] {
  const segments: Segment[] = [];

  for (let y = 0; y < grid.height - 1; y++) {
    for (let x = 0; x < grid.width - 1; x++) {
      const corners = [
        cellPoint(grid, x, y),
        cellPoint(grid, x + 1, y),
        cellPoint(grid, x + 1, y + 1),
        cellPoint(grid, x, y + 1),
      ];

      segments.push(...caseSegments(corners, level));
    }
  }

  return buildClosedRings(segments);
}
