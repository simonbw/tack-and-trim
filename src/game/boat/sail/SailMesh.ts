/**
 * Generate a triangular 2D particle mesh in normalized UV space for cloth simulation.
 * The sail is a triangle: foot (u-axis, along boom) and luff (v-axis, along mast).
 * Rows taper from footColumns at v=0 to 2 vertices at v=1.
 */

export interface SailMeshConfig {
  footColumns: number; // number of vertices along foot (u-axis)
  luffRows: number; // number of rows along luff (v-axis)
  taperFactor: number; // 0-1, how much the row width tapers (1.0 = pure triangle)
  zFoot: number; // z-height at foot (v=0)
  zHead: number; // z-height at head (v=1)
}

export interface SailMeshData {
  vertexCount: number;
  /** [u, v] pairs in normalized space, length = 2 * vertexCount */
  restPositions: Float64Array;
  /** Per-vertex z-height, length = vertexCount */
  zHeights: Float64Array;
  /** Triangle indices (3 per triangle) */
  indices: number[];
  /** Structural constraints: [idxA, idxB, restLength] */
  structuralConstraints: [number, number, number][];
  /** Shear (diagonal) constraints: [idxA, idxB, restLength] */
  shearConstraints: [number, number, number][];
  /** Bend (skip-one) constraints: [idxA, idxB, restLength] */
  bendConstraints: [number, number, number][];
  /** Vertex indices along luff (mast) edge (col=0 of each row) */
  luffVertices: number[];
  /** Vertex indices along foot (boom) row (row=0) */
  footVertices: number[];
  /** Vertex indices along leech edge (last col of each row) */
  leechVertices: number[];
  /** Index of first vertex in each row */
  rowStarts: number[];
  /** Number of columns in each row */
  colCounts: number[];
}

export function generateSailMesh(config: SailMeshConfig): SailMeshData {
  const { footColumns, luffRows, taperFactor, zFoot, zHead } = config;

  // Build rows: each row j has a varying number of columns that tapers
  const rowStarts: number[] = [];
  const colCounts: number[] = [];
  const positions: number[] = []; // u, v pairs
  const zHeights: number[] = [];

  let vertexCount = 0;

  for (let j = 0; j < luffRows; j++) {
    const v = j / (luffRows - 1);
    const colCount = Math.max(
      2,
      Math.round(footColumns * (1 - v * taperFactor)),
    );
    rowStarts.push(vertexCount);
    colCounts.push(colCount);

    const z = zFoot + (zHead - zFoot) * v;

    for (let i = 0; i < colCount; i++) {
      const u = colCount > 1 ? i / (colCount - 1) : 0;
      positions.push(u, v);
      zHeights.push(z);
      vertexCount++;
    }
  }

  const restPositions = new Float64Array(positions);
  const zHeightsArray = new Float64Array(zHeights);

  // Collect edge vertices
  const luffVertices: number[] = [];
  const footVertices: number[] = [];
  const leechVertices: number[] = [];

  for (let j = 0; j < luffRows; j++) {
    luffVertices.push(rowStarts[j]); // col 0
    leechVertices.push(rowStarts[j] + colCounts[j] - 1); // last col
  }
  for (let i = 0; i < colCounts[0]; i++) {
    footVertices.push(rowStarts[0] + i);
  }

  // Triangulation: stitch adjacent rows
  const indices: number[] = [];
  const edgeSet = new Set<string>(); // track structural edges
  const structuralConstraints: [number, number, number][] = [];

  const addEdge = (a: number, b: number) => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    if (!edgeSet.has(key)) {
      edgeSet.add(key);
      const au = restPositions[a * 2],
        av = restPositions[a * 2 + 1];
      const bu = restPositions[b * 2],
        bv = restPositions[b * 2 + 1];
      const dist = Math.hypot(bu - au, bv - av);
      structuralConstraints.push([a, b, dist]);
    }
  };

  for (let j = 0; j < luffRows - 1; j++) {
    const topStart = rowStarts[j];
    const topCount = colCounts[j];
    const botStart = rowStarts[j + 1];
    const botCount = colCounts[j + 1];

    // Walk both rows by u-parameter proximity, greedy stitching
    let ti = 0,
      bi = 0;
    while (ti < topCount - 1 || bi < botCount - 1) {
      const topIdx = topStart + ti;
      const botIdx = botStart + bi;

      if (ti >= topCount - 1) {
        // Only bottom row can advance
        indices.push(topIdx, botIdx, botIdx + 1);
        addEdge(topIdx, botIdx);
        addEdge(botIdx, botIdx + 1);
        addEdge(topIdx, botIdx + 1);
        bi++;
      } else if (bi >= botCount - 1) {
        // Only top row can advance
        indices.push(topIdx, botIdx, topIdx + 1);
        addEdge(topIdx, botIdx);
        addEdge(topIdx, topIdx + 1);
        addEdge(botIdx, topIdx + 1);
        ti++;
      } else {
        // Both can advance - pick the one whose next vertex is closer in u
        const topU = topCount > 1 ? (ti + 1) / (topCount - 1) : 1;
        const botU = botCount > 1 ? (bi + 1) / (botCount - 1) : 1;

        if (topU <= botU) {
          // Advance top
          indices.push(topIdx, botIdx, topIdx + 1);
          addEdge(topIdx, botIdx);
          addEdge(topIdx, topIdx + 1);
          addEdge(botIdx, topIdx + 1);
          ti++;
        } else {
          // Advance bottom
          indices.push(topIdx, botIdx, botIdx + 1);
          addEdge(topIdx, botIdx);
          addEdge(botIdx, botIdx + 1);
          addEdge(topIdx, botIdx + 1);
          bi++;
        }
      }
    }
  }

  // Shear constraints: diagonals within quads formed by adjacent row pairs
  const shearConstraints: [number, number, number][] = [];
  const shearSet = new Set<string>();

  for (let j = 0; j < luffRows - 1; j++) {
    const topStart = rowStarts[j];
    const topCount = colCounts[j];
    const botStart = rowStarts[j + 1];
    const botCount = colCounts[j + 1];

    // For each pair of adjacent vertices in the top row,
    // find the corresponding pair in the bottom row and add diagonals
    const minCount = Math.min(topCount, botCount);
    for (let i = 0; i < minCount - 1; i++) {
      // Map i to actual vertex indices proportionally
      const ti = Math.round((i / (minCount - 1)) * (topCount - 1));
      const ti2 = Math.round(((i + 1) / (minCount - 1)) * (topCount - 1));
      const bi = Math.round((i / (minCount - 1)) * (botCount - 1));
      const bi2 = Math.round(((i + 1) / (minCount - 1)) * (botCount - 1));

      // Single shear diagonal per quad — both diagonals would rigid-triangulate
      // the quad and prevent in-plane shear, making the cloth too stiff.
      const a1 = topStart + ti;
      const b1 = botStart + bi2;
      const key1 = a1 < b1 ? `${a1},${b1}` : `${b1},${a1}`;
      if (!shearSet.has(key1) && !edgeSet.has(key1)) {
        shearSet.add(key1);
        const du = restPositions[b1 * 2] - restPositions[a1 * 2];
        const dv = restPositions[b1 * 2 + 1] - restPositions[a1 * 2 + 1];
        shearConstraints.push([a1, b1, Math.hypot(du, dv)]);
      }
    }
  }

  // Bend constraints: skip-one along rows and columns
  const bendConstraints: [number, number, number][] = [];
  const bendSet = new Set<string>();

  const addBend = (a: number, b: number) => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    if (!bendSet.has(key)) {
      bendSet.add(key);
      const du = restPositions[b * 2] - restPositions[a * 2];
      const dv = restPositions[b * 2 + 1] - restPositions[a * 2 + 1];
      bendConstraints.push([a, b, Math.hypot(du, dv)]);
    }
  };

  // Skip-one along rows
  for (let j = 0; j < luffRows; j++) {
    const start = rowStarts[j];
    const count = colCounts[j];
    for (let i = 0; i < count - 2; i++) {
      addBend(start + i, start + i + 2);
    }
  }

  // Skip-one along columns (luff direction)
  for (let j = 0; j < luffRows - 2; j++) {
    const count0 = colCounts[j];
    const count2 = colCounts[j + 2];
    const minC = Math.min(count0, count2);
    for (let i = 0; i < minC; i++) {
      const idx0 = rowStarts[j] + Math.round((i / (minC - 1)) * (count0 - 1));
      const idx2 =
        rowStarts[j + 2] + Math.round((i / (minC - 1)) * (count2 - 1));
      addBend(idx0, idx2);
    }
  }

  return {
    vertexCount,
    restPositions,
    zHeights: zHeightsArray,
    indices,
    structuralConstraints,
    shearConstraints,
    bendConstraints,
    luffVertices,
    footVertices,
    leechVertices,
    rowStarts,
    colCounts,
  };
}
