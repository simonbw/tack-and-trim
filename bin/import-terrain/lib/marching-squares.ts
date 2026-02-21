export interface ScalarGrid {
  width: number;
  height: number;
  values: Float64Array;
  nodataMask?: Uint8Array;
}

export interface MarchSegments {
  segAx: Float64Array;
  segAy: Float64Array;
  segBx: Float64Array;
  segBy: Float64Array;
  segAEdge: Float64Array;
  segBEdge: Float64Array;
}

/**
 * Traces marching-squares segments into closed rings.
 * Yields one Float64Array per ring (flat x,y,x,y,...) as each ring is completed.
 */
export function* buildClosedRings(
  segs: MarchSegments,
): Generator<Float64Array> {
  const { segAx, segAy, segBx, segBy, segAEdge, segBEdge } = segs;
  const count = segAx.length;
  if (count === 0) {
    return;
  }

  // Build adjacency using integer edge IDs.
  // Map edgeID → index into allCoords (flat x,y pairs).
  const coordIdx = new Map<number, number>();
  const allCoords = new Float64Array(count * 4); // at most 2*count unique points
  let numCoords = 0;
  const adj = new Map<number, number[]>();

  for (let i = 0; i < count; i++) {
    const a = segAEdge[i];
    const b = segBEdge[i];

    if (!coordIdx.has(a)) {
      const idx = numCoords * 2;
      allCoords[idx] = segAx[i];
      allCoords[idx + 1] = segAy[i];
      coordIdx.set(a, idx);
      numCoords++;
    }
    if (!coordIdx.has(b)) {
      const idx = numCoords * 2;
      allCoords[idx] = segBx[i];
      allCoords[idx + 1] = segBy[i];
      coordIdx.set(b, idx);
      numCoords++;
    }

    let aList = adj.get(a);
    if (!aList) {
      aList = [];
      adj.set(a, aList);
    }
    aList.push(b);

    let bList = adj.get(b);
    if (!bList) {
      bList = [];
      adj.set(b, bList);
    }
    bList.push(a);
  }

  // Trace closed rings into flat coordinate arrays.
  // Reuse a single scratch buffer across rings to avoid repeated allocation.
  const visited = new Set<number>();
  const scratch: number[] = [];

  for (const startEdge of adj.keys()) {
    if (visited.has(startEdge)) continue;

    scratch.length = 0;
    let prev = -1;
    let curr = startEdge;

    for (;;) {
      visited.add(curr);
      const ci = coordIdx.get(curr)!;
      scratch.push(allCoords[ci], allCoords[ci + 1]);

      const neighbors = adj.get(curr)!;
      const next = neighbors[0] !== prev ? neighbors[0] : neighbors[1];

      if (next === undefined || next === startEdge) break;

      prev = curr;
      curr = next;
    }

    const numPoints = scratch.length / 2;
    if (numPoints >= 3) {
      // Check winding (signed area from flat coords)
      let area = 0;
      for (let i = 0; i < numPoints; i++) {
        const ci = i * 2;
        const ni = ((i + 1) % numPoints) * 2;
        area += scratch[ci] * scratch[ni + 1] - scratch[ni] * scratch[ci + 1];
      }
      if (area < 0) {
        // Reverse in-place
        for (let i = 0; i < Math.floor(numPoints / 2); i++) {
          const li = i * 2;
          const ri = (numPoints - 1 - i) * 2;
          const tx = scratch[li],
            ty = scratch[li + 1];
          scratch[li] = scratch[ri];
          scratch[li + 1] = scratch[ri + 1];
          scratch[ri] = tx;
          scratch[ri + 1] = ty;
        }
      }
      yield new Float64Array(scratch);
    }
  }
}

/**
 * Precomputed min/max elevation per block for fast contour-level skipping.
 */
export interface BlockIndex {
  blockCols: number;
  blockRows: number;
  blockMin: Float64Array;
  blockMax: Float64Array;
  blockHasNoData: Uint8Array;
}
