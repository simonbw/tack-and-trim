/**
 * Marching squares algorithm for extracting contour lines from a 2D elevation grid.
 */

type Point = [number, number];

// Edge indices: 0=top, 1=right, 2=bottom, 3=left
// For each cell configuration (0-15), which edges connect.
// Each entry is [edge1, edge2] pairs. The contour enters through one and exits through the other.
const EDGE_TABLE: [number, number][][] = [
  /* 0  */ [],
  /* 1  */ [[2, 3]],
  /* 2  */ [[1, 2]],
  /* 3  */ [[1, 3]],
  /* 4  */ [[0, 1]],
  /* 5  */ [[0, 3], [1, 2]], // saddle
  /* 6  */ [[0, 2]],
  /* 7  */ [[0, 3]],
  /* 8  */ [[0, 3]],
  /* 9  */ [[0, 2]],
  /* 10 */ [[0, 1], [2, 3]], // saddle
  /* 11 */ [[0, 1]],
  /* 12 */ [[1, 3]],
  /* 13 */ [[1, 2]],
  /* 14 */ [[2, 3]],
  /* 15 */ [],
];

// For each exit edge, what is the neighbor's row/col offset and entry edge?
// [dRow, dCol, entryEdge]
const NEIGHBOR: [number, number, number][] = [
  [-1, 0, 2], // exit top    → neighbor above, enter from bottom
  [0, 1, 3],  // exit right  → neighbor right, enter from left
  [1, 0, 0],  // exit bottom → neighbor below, enter from top
  [0, -1, 1], // exit left   → neighbor left, enter from right
];

/**
 * Extract closed contour polylines from a 2D grid at a given height threshold.
 *
 * @param grid - Row-major elevation data
 * @param width - Number of columns in the grid
 * @param height - Number of rows in the grid
 * @param threshold - The elevation value to contour at
 * @param originX - X coordinate of the grid origin (top-left corner)
 * @param originY - Y coordinate of the grid origin (top-left corner)
 * @param cellWidth - Width of each grid cell in output units
 * @param cellHeight - Height of each grid cell in output units
 * @returns Array of closed polylines, each an array of [x, y] points
 */
export function extractContours(
  grid: Float32Array | Float64Array,
  width: number,
  height: number,
  threshold: number,
  originX: number,
  originY: number,
  cellWidth: number,
  cellHeight: number,
): Point[][] {
  const contours: Point[][] = [];

  // Number of cells is (width-1) × (height-1)
  const cellsW = width - 1;
  const cellsH = height - 1;

  // Visited tracking: 4 bits per cell (one per edge), packed into Uint8Array
  // Bit 0 = top, bit 1 = right, bit 2 = bottom, bit 3 = left
  const visited = new Uint8Array(cellsW * cellsH);

  function isVisited(row: number, col: number, edge: number): boolean {
    return (visited[row * cellsW + col] & (1 << edge)) !== 0;
  }

  function markVisited(row: number, col: number, edge: number): void {
    visited[row * cellsW + col] |= 1 << edge;
  }

  // Precompute "above threshold" flags for each grid point
  const above = new Uint8Array(width * height);
  for (let i = 0; i < grid.length; i++) {
    above[i] = grid[i] >= threshold ? 1 : 0;
  }

  function getCellConfig(row: number, col: number): number {
    const tl = above[row * width + col];
    const tr = above[row * width + col + 1];
    const br = above[(row + 1) * width + col + 1];
    const bl = above[(row + 1) * width + col];
    return (tl << 3) | (tr << 2) | (br << 1) | bl;
  }

  function interpolateEdge(row: number, col: number, edge: number): Point {
    let v1: number, v2: number, t: number;
    let x: number, y: number;

    switch (edge) {
      case 0: // top: (row,col) to (row,col+1)
        v1 = grid[row * width + col];
        v2 = grid[row * width + col + 1];
        t = v2 !== v1 ? (threshold - v1) / (v2 - v1) : 0.5;
        x = col + t;
        y = row;
        break;
      case 1: // right: (row,col+1) to (row+1,col+1)
        v1 = grid[row * width + col + 1];
        v2 = grid[(row + 1) * width + col + 1];
        t = v2 !== v1 ? (threshold - v1) / (v2 - v1) : 0.5;
        x = col + 1;
        y = row + t;
        break;
      case 2: // bottom: (row+1,col) to (row+1,col+1)
        v1 = grid[(row + 1) * width + col];
        v2 = grid[(row + 1) * width + col + 1];
        t = v2 !== v1 ? (threshold - v1) / (v2 - v1) : 0.5;
        x = col + t;
        y = row + 1;
        break;
      case 3: // left: (row,col) to (row+1,col)
        v1 = grid[row * width + col];
        v2 = grid[(row + 1) * width + col];
        t = v2 !== v1 ? (threshold - v1) / (v2 - v1) : 0.5;
        x = col;
        y = row + t;
        break;
      default:
        throw new Error(`Invalid edge: ${edge}`);
    }

    return [originX + x * cellWidth, originY + y * cellHeight];
  }

  function traceContour(
    startRow: number,
    startCol: number,
    startEntry: number,
  ): Point[] {
    const points: Point[] = [];
    let row = startRow;
    let col = startCol;
    let entry = startEntry;

    const maxIter = cellsW * cellsH * 2;
    let iter = 0;

    do {
      if (++iter > maxIter) break;

      const config = getCellConfig(row, col);
      const connections = EDGE_TABLE[config];

      // Find exit edge matching our entry
      let exit = -1;
      for (const [e1, e2] of connections) {
        if (e1 === entry) {
          exit = e2;
          break;
        }
        if (e2 === entry) {
          exit = e1;
          break;
        }
      }
      if (exit === -1) break;

      // Mark both edges as visited for this cell
      markVisited(row, col, entry);
      markVisited(row, col, exit);

      // Add the interpolated point at the exit edge
      points.push(interpolateEdge(row, col, exit));

      // Move to neighbor
      const [dr, dc, nextEntry] = NEIGHBOR[exit];
      const nr = row + dr;
      const nc = col + dc;

      // Boundary check
      if (nr < 0 || nr >= cellsH || nc < 0 || nc >= cellsW) break;

      // Check if we've closed the loop
      if (nr === startRow && nc === startCol && nextEntry === startEntry) break;

      row = nr;
      col = nc;
      entry = nextEntry;
    } while (true);

    return points;
  }

  // Scan all cells for unvisited contour crossings
  for (let row = 0; row < cellsH; row++) {
    for (let col = 0; col < cellsW; col++) {
      const config = getCellConfig(row, col);
      const connections = EDGE_TABLE[config];

      for (const [e1, e2] of connections) {
        // Check if either edge of this connection is already visited
        if (isVisited(row, col, e1) || isVisited(row, col, e2)) continue;

        const points = traceContour(row, col, e1);
        if (points.length >= 3) {
          contours.push(points);
        }
      }
    }
  }

  return contours;
}
