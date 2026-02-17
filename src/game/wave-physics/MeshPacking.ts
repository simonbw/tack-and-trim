/**
 * CPU-side mesh packing for wavefront mesh query lookup.
 *
 * Packs vertex/index data and a spatial grid index into a single array<u32>
 * buffer for GPU compute shader access. The spatial grid enables efficient
 * triangle lookup via barycentric interpolation.
 *
 * Buffer layout:
 * GLOBAL HEADER (16 u32s):
 *   [0]     numWaveSources
 *   [1..8]  meshOffset[0..7] (absolute u32 offset to each wave's mesh header)
 *   [9..15] padding
 *
 * PER-WAVE MESH HEADER (16 u32s each):
 *   [+0]  vertexOffset      [+1]  vertexCount
 *   [+2]  indexOffset        [+3]  triangleCount
 *   [+4]  gridOffset         [+5]  gridCols
 *   [+6]  gridRows           [+7]  gridMinX (f32)
 *   [+8]  gridMinY (f32)     [+9]  gridCellWidth (f32)
 *   [+10] gridCellHeight (f32) [+11] gridCosA (f32)
 *   [+12] gridSinA (f32)     [+13..15] padding
 *
 * VERTEX DATA (6 f32-as-u32 per vertex, all sources concatenated)
 * INDEX DATA (3 u32 per triangle, all sources concatenated)
 * GRID CELL HEADERS (2 u32 per cell: triListOffset, triListCount)
 * GRID TRIANGLE LISTS (u32 triangle indices, variable length per cell)
 */

import { MAX_WAVE_SOURCES } from "./WavePhysicsManager";
import { VERTEX_FLOATS } from "./WavefrontMesh";
import type { WavefrontMesh } from "./WavefrontMesh";

const GLOBAL_HEADER_U32S = 16;
const MESH_HEADER_U32S = 16;
const MAX_GRID_DIM = 1024;
const ENABLE_MESH_PACKING_LOGS = false;

/** Float bits → u32 for buffer packing */
const f32Buf = new Float32Array(1);
const u32Buf = new Uint32Array(f32Buf.buffer);
function floatToU32(f: number): number {
  f32Buf[0] = f;
  return u32Buf[0];
}

interface MeshGridData {
  /** Per-cell triangle lists */
  cells: Uint32Array[];
  /** Grid dimensions */
  cols: number;
  rows: number;
  /** Grid AABB in rotated (wave-aligned) space */
  minX: number;
  minY: number;
  /** Cell dimensions in world units (rectangular, matching triangle aspect ratio) */
  cellWidth: number;
  cellHeight: number;
  /** Rotation from world space to grid space (cos/sin of wave direction) */
  cosA: number;
  sinA: number;
}

/**
 * Build a spatial grid index for a single mesh.
 * The grid is built in wave-aligned (rotated) space for tighter packing.
 */
function buildSpatialGrid(mesh: WavefrontMesh): MeshGridData {
  const verts = mesh.cpuVertexData;
  const indices = mesh.cpuIndexData;
  const triCount = mesh.indexCount / 3;

  // Rotation to wave-aligned space
  const cosA = Math.cos(mesh.waveDirection);
  const sinA = Math.sin(mesh.waveDirection);

  // Compute AABB in rotated space
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (let v = 0; v < mesh.vertexCount; v++) {
    const wx = verts[v * VERTEX_FLOATS];
    const wy = verts[v * VERTEX_FLOATS + 1];
    const rx = wx * cosA + wy * sinA;
    const ry = -wx * sinA + wy * cosA;
    minX = Math.min(minX, rx);
    minY = Math.min(minY, ry);
    maxX = Math.max(maxX, rx);
    maxY = Math.max(maxY, ry);
  }

  // Add margin
  const margin = 10;
  minX -= margin;
  minY -= margin;
  maxX += margin;
  maxY += margin;

  const width = maxX - minX;
  const height = maxY - minY;

  // Compute average triangle x/y extents for aspect ratio
  let totalXExtent = 0;
  let totalYExtent = 0;
  for (let t = 0; t < triCount; t++) {
    const i0 = indices[t * 3];
    const i1 = indices[t * 3 + 1];
    const i2 = indices[t * 3 + 2];
    const rx0 =
      verts[i0 * VERTEX_FLOATS] * cosA + verts[i0 * VERTEX_FLOATS + 1] * sinA;
    const ry0 =
      -verts[i0 * VERTEX_FLOATS] * sinA + verts[i0 * VERTEX_FLOATS + 1] * cosA;
    const rx1 =
      verts[i1 * VERTEX_FLOATS] * cosA + verts[i1 * VERTEX_FLOATS + 1] * sinA;
    const ry1 =
      -verts[i1 * VERTEX_FLOATS] * sinA + verts[i1 * VERTEX_FLOATS + 1] * cosA;
    const rx2 =
      verts[i2 * VERTEX_FLOATS] * cosA + verts[i2 * VERTEX_FLOATS + 1] * sinA;
    const ry2 =
      -verts[i2 * VERTEX_FLOATS] * sinA + verts[i2 * VERTEX_FLOATS + 1] * cosA;
    totalXExtent += Math.max(rx0, rx1, rx2) - Math.min(rx0, rx1, rx2);
    totalYExtent += Math.max(ry0, ry1, ry2) - Math.min(ry0, ry1, ry2);
  }
  const avgXExtent = totalXExtent / triCount;
  const avgYExtent = totalYExtent / triCount;

  // Rectangular cells sized to triangle density with matching aspect ratio.
  // Dividing area by 4 halves the linear cell dimensions for finer resolution.
  const meshArea = width * height;
  const targetCellArea = meshArea / triCount / 4;
  const aspect = avgXExtent / Math.max(avgYExtent, 1e-10);
  let cellWidth = Math.sqrt(targetCellArea * aspect);
  let cellHeight = Math.sqrt(targetCellArea / aspect);

  // Clamp each dimension to MAX_GRID_DIM independently
  cellWidth = Math.max(cellWidth, width / MAX_GRID_DIM);
  cellHeight = Math.max(cellHeight, height / MAX_GRID_DIM);
  const cols = Math.max(1, Math.ceil(width / cellWidth));
  const rows = Math.max(1, Math.ceil(height / cellHeight));

  // Build cell → triangle mappings using rotated coordinates
  const cellTriLists: number[][] = [];
  for (let i = 0; i < cols * rows; i++) {
    cellTriLists.push([]);
  }

  const invCellWidth = 1 / cellWidth;
  const invCellHeight = 1 / cellHeight;

  for (let t = 0; t < triCount; t++) {
    const i0 = indices[t * 3];
    const i1 = indices[t * 3 + 1];
    const i2 = indices[t * 3 + 2];

    // Rotated vertices — sort by y (ascending) for scanline rasterization
    let sx0 =
      verts[i0 * VERTEX_FLOATS] * cosA + verts[i0 * VERTEX_FLOATS + 1] * sinA;
    let sy0 =
      -verts[i0 * VERTEX_FLOATS] * sinA + verts[i0 * VERTEX_FLOATS + 1] * cosA;
    let sx1 =
      verts[i1 * VERTEX_FLOATS] * cosA + verts[i1 * VERTEX_FLOATS + 1] * sinA;
    let sy1 =
      -verts[i1 * VERTEX_FLOATS] * sinA + verts[i1 * VERTEX_FLOATS + 1] * cosA;
    let sx2 =
      verts[i2 * VERTEX_FLOATS] * cosA + verts[i2 * VERTEX_FLOATS + 1] * sinA;
    let sy2 =
      -verts[i2 * VERTEX_FLOATS] * sinA + verts[i2 * VERTEX_FLOATS + 1] * cosA;

    // Sort by y: sy0 <= sy1 <= sy2
    let tmp: number;
    if (sy0 > sy1) {
      tmp = sx0;
      sx0 = sx1;
      sx1 = tmp;
      tmp = sy0;
      sy0 = sy1;
      sy1 = tmp;
    }
    if (sy1 > sy2) {
      tmp = sx1;
      sx1 = sx2;
      sx2 = tmp;
      tmp = sy1;
      sy1 = sy2;
      sy2 = tmp;
    }
    if (sy0 > sy1) {
      tmp = sx0;
      sx0 = sx1;
      sx1 = tmp;
      tmp = sy0;
      sy0 = sy1;
      sy1 = tmp;
    }

    // Skip degenerate triangles
    const dy02 = sy2 - sy0;
    if (dy02 < 1e-10) continue;

    const dy01 = sy1 - sy0;
    const dy12 = sy2 - sy1;
    const dx02 = sx2 - sx0;
    const dx01 = sx1 - sx0;
    const dx12 = sx2 - sx1;
    const invDy02 = 1 / dy02;
    const invDy01 = dy01 > 1e-10 ? 1 / dy01 : 0;
    const invDy12 = dy12 > 1e-10 ? 1 / dy12 : 0;

    // Scanline: for each grid row the triangle spans, compute the x range
    const rStart = Math.max(0, Math.floor((sy0 - minY) * invCellHeight));
    const rEnd = Math.min(rows - 1, Math.floor((sy2 - minY) * invCellHeight));

    for (let r = rStart; r <= rEnd; r++) {
      const yTop = minY + r * cellHeight;
      const yBot = yTop + cellHeight;
      const yLo = Math.max(yTop, sy0);
      const yHi = Math.min(yBot, sy2);

      // x along the long edge (v0→v2) at yLo and yHi
      let xMin = sx0 + (yLo - sy0) * invDy02 * dx02;
      let xMax = xMin;
      const xLong_hi = sx0 + (yHi - sy0) * invDy02 * dx02;
      if (xLong_hi < xMin) xMin = xLong_hi;
      if (xLong_hi > xMax) xMax = xLong_hi;

      // x along the short edge(s)
      if (yLo < sy1 && invDy01 !== 0) {
        const xShort = sx0 + (yLo - sy0) * invDy01 * dx01;
        if (xShort < xMin) xMin = xShort;
        if (xShort > xMax) xMax = xShort;
        const yEnd = Math.min(yHi, sy1);
        const xShortEnd = sx0 + (yEnd - sy0) * invDy01 * dx01;
        if (xShortEnd < xMin) xMin = xShortEnd;
        if (xShortEnd > xMax) xMax = xShortEnd;
      }
      if (yHi > sy1 && invDy12 !== 0) {
        const yStart = Math.max(yLo, sy1);
        const xShort = sx1 + (yStart - sy1) * invDy12 * dx12;
        if (xShort < xMin) xMin = xShort;
        if (xShort > xMax) xMax = xShort;
        const xShortEnd = sx1 + (yHi - sy1) * invDy12 * dx12;
        if (xShortEnd < xMin) xMin = xShortEnd;
        if (xShortEnd > xMax) xMax = xShortEnd;
      }

      // Include v1 if it falls in this row
      if (sy1 >= yTop && sy1 <= yBot) {
        if (sx1 < xMin) xMin = sx1;
        if (sx1 > xMax) xMax = sx1;
      }

      const cStart = Math.max(0, Math.floor((xMin - minX) * invCellWidth));
      const cEnd = Math.min(cols - 1, Math.floor((xMax - minX) * invCellWidth));

      for (let c = cStart; c <= cEnd; c++) {
        cellTriLists[r * cols + c].push(t);
      }
    }
  }

  // Convert to Uint32Arrays
  const cells = cellTriLists.map((list) => new Uint32Array(list));

  const grid = {
    cells,
    cols,
    rows,
    minX,
    minY,
    cellWidth,
    cellHeight,
    cosA,
    sinA,
  };
  if (ENABLE_MESH_PACKING_LOGS) {
    logGridStats(mesh, grid);
  }
  return grid;
}

/**
 * Build a packed mesh GPU buffer from wavefront meshes.
 * Returns null if no meshes are provided.
 */
export function buildPackedMeshBuffer(
  device: GPUDevice,
  meshes: readonly WavefrontMesh[],
): GPUBuffer {
  const numWaves = Math.min(meshes.length, MAX_WAVE_SOURCES);

  // Build spatial grids for each mesh
  const grids: MeshGridData[] = [];
  for (let i = 0; i < numWaves; i++) {
    grids.push(buildSpatialGrid(meshes[i]));
  }

  // Calculate total buffer size
  let totalU32s = GLOBAL_HEADER_U32S;
  totalU32s += numWaves * MESH_HEADER_U32S;

  // Vertex data
  let totalVertexU32s = 0;
  for (let i = 0; i < numWaves; i++) {
    totalVertexU32s += meshes[i].vertexCount * VERTEX_FLOATS;
  }
  totalU32s += totalVertexU32s;

  // Index data
  let totalIndexU32s = 0;
  for (let i = 0; i < numWaves; i++) {
    totalIndexU32s += meshes[i].indexCount;
  }
  totalU32s += totalIndexU32s;

  // Grid cell headers + triangle lists
  let totalGridHeaderU32s = 0;
  let totalGridListU32s = 0;
  for (const grid of grids) {
    totalGridHeaderU32s += grid.cols * grid.rows * 2;
    for (const cell of grid.cells) {
      totalGridListU32s += cell.length;
    }
  }
  totalU32s += totalGridHeaderU32s + totalGridListU32s;

  // Allocate buffer
  const data = new ArrayBuffer(totalU32s * 4);
  const u32View = new Uint32Array(data);
  const f32View = new Float32Array(data);

  // Write global header
  u32View[0] = numWaves;

  // Calculate offsets
  const headersStart = GLOBAL_HEADER_U32S;
  let vertexStart = headersStart + numWaves * MESH_HEADER_U32S;
  let indexStart = vertexStart + totalVertexU32s;
  let gridHeaderStart = indexStart + totalIndexU32s;
  let gridListStart = gridHeaderStart + totalGridHeaderU32s;

  let currentVertexOffset = vertexStart;
  let currentIndexOffset = indexStart;
  let currentGridHeaderOffset = gridHeaderStart;
  let currentGridListOffset = gridListStart;

  for (let w = 0; w < numWaves; w++) {
    const mesh = meshes[w];
    const grid = grids[w];
    const headerOffset = headersStart + w * MESH_HEADER_U32S;

    // Write mesh offset to global header
    u32View[1 + w] = headerOffset;

    // Write per-wave mesh header
    u32View[headerOffset + 0] = currentVertexOffset;
    u32View[headerOffset + 1] = mesh.vertexCount;
    u32View[headerOffset + 2] = currentIndexOffset;
    u32View[headerOffset + 3] = mesh.indexCount / 3;
    u32View[headerOffset + 4] = currentGridHeaderOffset;
    u32View[headerOffset + 5] = grid.cols;
    u32View[headerOffset + 6] = grid.rows;
    u32View[headerOffset + 7] = floatToU32(grid.minX);
    u32View[headerOffset + 8] = floatToU32(grid.minY);
    u32View[headerOffset + 9] = floatToU32(grid.cellWidth);
    u32View[headerOffset + 10] = floatToU32(grid.cellHeight);
    u32View[headerOffset + 11] = floatToU32(grid.cosA);
    u32View[headerOffset + 12] = floatToU32(grid.sinA);

    // Write vertex data (6 floats per vertex, stored as u32 via shared buffer)
    for (let v = 0; v < mesh.vertexCount * VERTEX_FLOATS; v++) {
      f32View[currentVertexOffset + v] = mesh.cpuVertexData[v];
    }
    currentVertexOffset += mesh.vertexCount * VERTEX_FLOATS;

    // Write index data
    for (let idx = 0; idx < mesh.indexCount; idx++) {
      u32View[currentIndexOffset + idx] = mesh.cpuIndexData[idx];
    }
    currentIndexOffset += mesh.indexCount;

    // Write grid cell headers and triangle lists
    const numCells = grid.cols * grid.rows;
    for (let c = 0; c < numCells; c++) {
      const cell = grid.cells[c];
      u32View[currentGridHeaderOffset + c * 2] = currentGridListOffset;
      u32View[currentGridHeaderOffset + c * 2 + 1] = cell.length;

      for (let t = 0; t < cell.length; t++) {
        u32View[currentGridListOffset + t] = cell[t];
      }
      currentGridListOffset += cell.length;
    }
    currentGridHeaderOffset += numCells * 2;
  }

  // Pad remaining global header slots
  for (let i = numWaves; i < MAX_WAVE_SOURCES; i++) {
    u32View[1 + i] = 0;
  }

  if (ENABLE_MESH_PACKING_LOGS) {
    logBufferStats(
      numWaves,
      totalU32s,
      totalVertexU32s,
      totalIndexU32s,
      totalGridHeaderU32s,
      totalGridListU32s,
    );
  }

  // Create GPU buffer
  const buffer = device.createBuffer({
    size: Math.max(data.byteLength, 64), // min 64 bytes
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    label: "Packed Wavefront Mesh Buffer",
  });
  device.queue.writeBuffer(buffer, 0, data);

  return buffer;
}

// ---------------------------------------------------------------------------
// Diagnostic logging
// ---------------------------------------------------------------------------

function logGridStats(mesh: WavefrontMesh, grid: MeshGridData): void {
  const { cells, cols, rows, minX, minY, cellWidth, cellHeight, cosA, sinA } =
    grid;
  const triCount = mesh.indexCount / 3;
  const verts = mesh.cpuVertexData;
  const indices = mesh.cpuIndexData;
  const totalCells = cols * rows;

  // Basic cell stats
  let totalRefs = 0;
  let maxTrisInCell = 0;
  let nonEmptyCells = 0;
  for (const cell of cells) {
    totalRefs += cell.length;
    if (cell.length > 0) nonEmptyCells++;
    maxTrisInCell = Math.max(maxTrisInCell, cell.length);
  }
  const avgPerCell = nonEmptyCells > 0 ? totalRefs / nonEmptyCells : 0;

  // Histogram of per-cell triangle counts
  const buckets = [0, 5, 10, 20, 50, 100, Infinity] as const;
  const histogram = new Map<number, number>();
  for (const cell of cells) {
    const bucket = buckets.find((b) => cell.length <= b) ?? Infinity;
    histogram.set(bucket, (histogram.get(bucket) ?? 0) + 1);
  }

  // Measure actual point-in-triangle overlap by sampling each cell's center
  let maxActualOverlap = 0;
  let totalActualOverlap = 0;
  let sampledCells = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = cells[r * cols + c];
      if (cell.length === 0) continue;

      // Cell center in rotated space → world space
      const cxRot = minX + (c + 0.5) * cellWidth;
      const cyRot = minY + (r + 0.5) * cellHeight;
      const px = cxRot * cosA - cyRot * sinA;
      const py = cxRot * sinA + cyRot * cosA;

      let actual = 0;
      for (let ti = 0; ti < cell.length; ti++) {
        const t = cell[ti];
        const ax = verts[indices[t * 3] * VERTEX_FLOATS];
        const ay = verts[indices[t * 3] * VERTEX_FLOATS + 1];
        const bx = verts[indices[t * 3 + 1] * VERTEX_FLOATS];
        const by = verts[indices[t * 3 + 1] * VERTEX_FLOATS + 1];
        const cx = verts[indices[t * 3 + 2] * VERTEX_FLOATS];
        const cy = verts[indices[t * 3 + 2] * VERTEX_FLOATS + 1];

        const v0x = bx - ax,
          v0y = by - ay;
        const v1x = cx - ax,
          v1y = cy - ay;
        const v2x = px - ax,
          v2y = py - ay;
        const d00 = v0x * v0x + v0y * v0y;
        const d01 = v0x * v1x + v0y * v1y;
        const d11 = v1x * v1x + v1y * v1y;
        const d20 = v2x * v0x + v2y * v0y;
        const d21 = v2x * v1x + v2y * v1y;
        const denom = d00 * d11 - d01 * d01;
        if (Math.abs(denom) < 1e-10) continue;
        const inv = 1 / denom;
        const u = (d11 * d20 - d01 * d21) * inv;
        const w = (d00 * d21 - d01 * d20) * inv;
        if (u >= -0.001 && w >= -0.001 && 1 - u - w >= -0.001) {
          actual++;
        }
      }
      maxActualOverlap = Math.max(maxActualOverlap, actual);
      totalActualOverlap += actual;
      sampledCells++;
    }
  }
  const avgActualOverlap =
    sampledCells > 0 ? totalActualOverlap / sampledCells : 0;

  const gridMemoryKB = ((totalCells * 2 + totalRefs) * 4) / 1024;

  console.log(
    `[MeshPacking] Spatial grid for wave ${mesh.vertexCount} verts, ${triCount} tris:` +
      `\n  Grid: ${cols}×${rows} = ${totalCells} cells, cellSize=${cellWidth.toFixed(1)}×${cellHeight.toFixed(1)}` +
      `\n  Non-empty cells: ${nonEmptyCells}/${totalCells} (${((nonEmptyCells / totalCells) * 100).toFixed(0)}%)` +
      `\n  Triangle refs: ${totalRefs} (${(totalRefs / triCount).toFixed(1)}× expansion from ${triCount} tris)` +
      `\n  Per non-empty cell: avg=${avgPerCell.toFixed(1)}, max=${maxTrisInCell}` +
      `\n  Actual overlap (cell center sample): avg=${avgActualOverlap.toFixed(1)}, max=${maxActualOverlap}` +
      `\n  Histogram: ${[...histogram.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([k, v]) => `≤${k === Infinity ? "∞" : k}:${v}`)
        .join(", ")}` +
      `\n  Grid memory: ${gridMemoryKB.toFixed(1)} KB`,
  );
}

function logBufferStats(
  numWaves: number,
  totalU32s: number,
  vertexU32s: number,
  indexU32s: number,
  gridHeaderU32s: number,
  gridListU32s: number,
): void {
  const pct = (n: number) => ((n / totalU32s) * 100).toFixed(0);
  console.log(
    `[MeshPacking] Packed mesh buffer: ${numWaves} wave(s), ${((totalU32s * 4) / 1024).toFixed(1)} KB` +
      `\n  Vertices: ${pct(vertexU32s)}%, Indices: ${pct(indexU32s)}%` +
      `\n  Grid headers: ${pct(gridHeaderU32s)}%, Grid lists: ${pct(gridListU32s)}%`,
  );
}

/**
 * Create a placeholder packed mesh buffer with numWaveSources = 0.
 */
export function createPlaceholderPackedMeshBuffer(device: GPUDevice): GPUBuffer {
  const buffer = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    label: "Placeholder Packed Mesh Buffer",
  });
  const data = new Uint32Array(GLOBAL_HEADER_U32S);
  data[0] = 0; // numWaveSources = 0
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}
