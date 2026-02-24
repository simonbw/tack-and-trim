/**
 * Incremental spatial grid for segment intersection queries.
 * Used during constrained simplification to prevent contour intersections.
 */

export interface SegmentIndex {
  /** Insert all segments of a contour into the index. */
  addContourSegments(contourIndex: number, points: [number, number][]): void;
  /** Remove all segments of a contour from the index. */
  removeContourSegments(contourIndex: number): void;
  /** Test whether a candidate segment intersects any indexed segment. */
  segmentIntersectsAny(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    excludeContour: number,
  ): boolean;
}

interface CellEntry {
  contourIndex: number;
  /** Index into the contour's points array (segment is points[si]→points[si+1]) */
  segIndex: number;
}

function segmentsIntersect(
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
  p3x: number,
  p3y: number,
  p4x: number,
  p4y: number,
): boolean {
  const d1x = p2x - p1x;
  const d1y = p2y - p1y;
  const d2x = p4x - p3x;
  const d2y = p4y - p3y;

  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-12) return false;

  const t = ((p3x - p1x) * d2y - (p3y - p1y) * d2x) / denom;
  const u = ((p3x - p1x) * d1y - (p3y - p1y) * d1x) / denom;

  const eps = 1e-9;
  return t > eps && t < 1 - eps && u > eps && u < 1 - eps;
}

/**
 * All stored contour points, indexed by contourIndex.
 * We store references so segment lookups don't need copies.
 */
interface StoredContour {
  points: [number, number][];
}

export function createSegmentIndex(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  cellSize: number,
): SegmentIndex {
  const cols = Math.ceil((maxX - minX) / cellSize) + 1;
  const rows = Math.ceil((maxY - minY) / cellSize) + 1;
  const numCells = cols * rows;

  // Dynamic array-of-arrays grid for incremental insertion
  const cells: CellEntry[][] = new Array(numCells);
  for (let i = 0; i < numCells; i++) {
    cells[i] = [];
  }

  const storedContours = new Map<number, StoredContour>();

  function cellKey(cx: number, cy: number): number {
    return cy * cols + cx;
  }

  function addContourSegments(
    contourIndex: number,
    points: [number, number][],
  ): void {
    storedContours.set(contourIndex, { points });
    const n = points.length;

    for (let si = 0; si < n; si++) {
      const [x1, y1] = points[si];
      const [x2, y2] = points[(si + 1) % n];

      const minCx = Math.max(
        0,
        Math.floor((Math.min(x1, x2) - minX) / cellSize),
      );
      const maxCx = Math.min(
        cols - 1,
        Math.floor((Math.max(x1, x2) - minX) / cellSize),
      );
      const minCy = Math.max(
        0,
        Math.floor((Math.min(y1, y2) - minY) / cellSize),
      );
      const maxCy = Math.min(
        rows - 1,
        Math.floor((Math.max(y1, y2) - minY) / cellSize),
      );

      const entry: CellEntry = { contourIndex, segIndex: si };
      for (let cy = minCy; cy <= maxCy; cy++) {
        for (let cx = minCx; cx <= maxCx; cx++) {
          cells[cellKey(cx, cy)].push(entry);
        }
      }
    }
  }

  function removeContourSegments(contourIndex: number): void {
    const stored = storedContours.get(contourIndex);
    if (!stored) return;

    // Remove entries from all cells that reference this contour
    for (let i = 0; i < numCells; i++) {
      const cell = cells[i];
      if (cell.length === 0) continue;
      // Filter in-place
      let write = 0;
      for (let r = 0; r < cell.length; r++) {
        if (cell[r].contourIndex !== contourIndex) {
          cell[write++] = cell[r];
        }
      }
      cell.length = write;
    }

    storedContours.delete(contourIndex);
  }

  function segmentIntersectsAny(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    excludeContour: number,
  ): boolean {
    const minCx = Math.max(0, Math.floor((Math.min(ax, bx) - minX) / cellSize));
    const maxCx = Math.min(
      cols - 1,
      Math.floor((Math.max(ax, bx) - minX) / cellSize),
    );
    const minCy = Math.max(0, Math.floor((Math.min(ay, by) - minY) / cellSize));
    const maxCy = Math.min(
      rows - 1,
      Math.floor((Math.max(ay, by) - minY) / cellSize),
    );

    // Track already-tested segments to avoid duplicate checks across cells
    const tested = new Set<number>();

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const cell = cells[cellKey(cx, cy)];
        for (let i = 0; i < cell.length; i++) {
          const entry = cell[i];
          if (entry.contourIndex === excludeContour) continue;

          // Pack contourIndex + segIndex into a unique key
          const key = entry.contourIndex * 1000000 + entry.segIndex;
          if (tested.has(key)) continue;
          tested.add(key);

          const stored = storedContours.get(entry.contourIndex)!;
          const pts = stored.points;
          const si2 = (entry.segIndex + 1) % pts.length;
          const [p3x, p3y] = pts[entry.segIndex];
          const [p4x, p4y] = pts[si2];

          if (segmentsIntersect(ax, ay, bx, by, p3x, p3y, p4x, p4y)) {
            return true;
          }
        }
      }
    }

    return false;
  }

  return { addContourSegments, removeContourSegments, segmentIntersectsAny };
}
