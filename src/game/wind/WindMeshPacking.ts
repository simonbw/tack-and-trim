/**
 * CPU-side wind mesh packing for GPU compute shader access.
 *
 * Packs vertex/index data and a spatial grid index into a single array<u32>
 * buffer. Simpler than wave mesh packing: single mesh, axis-aligned grid,
 * 5 floats per vertex.
 *
 * Buffer layout:
 * HEADER (16 u32s):
 *   [0]  hasMesh (0 or 1)
 *   [1]  vertexOffset    [2]  vertexCount
 *   [3]  indexOffset      [4]  triangleCount
 *   [5]  gridOffset       [6]  gridCols       [7]  gridRows
 *   [8]  gridMinX (f32)   [9]  gridMinY (f32)
 *   [10] gridCellWidth    [11] gridCellHeight
 *   [12..15] padding
 *
 * VERTEX DATA (5 f32-as-u32 per vertex)
 * INDEX DATA (3 u32 per triangle)
 * GRID CELL HEADERS (2 u32 per cell: triListOffset, triListCount)
 * GRID TRIANGLE LISTS (u32 triangle indices, variable length per cell)
 */

import type { WindMeshFileData } from "../../pipeline/mesh-building/WindmeshFile";

const HEADER_U32S = 16;
const WIND_VERTEX_FLOATS = 5;

const f32Buf = new Float32Array(1);
const u32Buf = new Uint32Array(f32Buf.buffer);
function floatToU32(f: number): number {
  f32Buf[0] = f;
  return u32Buf[0];
}

/**
 * Build a spatial grid index for the wind mesh.
 * Axis-aligned (no rotation needed).
 */
function buildSpatialGrid(mesh: WindMeshFileData): Uint32Array[] {
  const verts = mesh.vertices;
  const indices = mesh.indices;
  const triCount = mesh.indexCount / 3;
  const {
    gridCols,
    gridRows,
    gridMinX,
    gridMinY,
    gridCellWidth,
    gridCellHeight,
  } = mesh;

  const cellTriLists: number[][] = [];
  for (let i = 0; i < gridCols * gridRows; i++) {
    cellTriLists.push([]);
  }

  const invCellWidth = 1 / gridCellWidth;
  const invCellHeight = 1 / gridCellHeight;

  for (let t = 0; t < triCount; t++) {
    const i0 = indices[t * 3];
    const i1 = indices[t * 3 + 1];
    const i2 = indices[t * 3 + 2];

    let sx0 = verts[i0 * WIND_VERTEX_FLOATS];
    let sy0 = verts[i0 * WIND_VERTEX_FLOATS + 1];
    let sx1 = verts[i1 * WIND_VERTEX_FLOATS];
    let sy1 = verts[i1 * WIND_VERTEX_FLOATS + 1];
    let sx2 = verts[i2 * WIND_VERTEX_FLOATS];
    let sy2 = verts[i2 * WIND_VERTEX_FLOATS + 1];

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

    const rStart = Math.max(0, Math.floor((sy0 - gridMinY) * invCellHeight));
    const rEnd = Math.min(
      gridRows - 1,
      Math.floor((sy2 - gridMinY) * invCellHeight),
    );

    for (let r = rStart; r <= rEnd; r++) {
      const yTop = gridMinY + r * gridCellHeight;
      const yBot = yTop + gridCellHeight;
      const yLo = Math.max(yTop, sy0);
      const yHi = Math.min(yBot, sy2);

      let xMin = sx0 + (yLo - sy0) * invDy02 * dx02;
      let xMax = xMin;
      const xLong_hi = sx0 + (yHi - sy0) * invDy02 * dx02;
      if (xLong_hi < xMin) xMin = xLong_hi;
      if (xLong_hi > xMax) xMax = xLong_hi;

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

      if (sy1 >= yTop && sy1 <= yBot) {
        if (sx1 < xMin) xMin = sx1;
        if (sx1 > xMax) xMax = sx1;
      }

      const cStart = Math.max(0, Math.floor((xMin - gridMinX) * invCellWidth));
      const cEnd = Math.min(
        gridCols - 1,
        Math.floor((xMax - gridMinX) * invCellWidth),
      );

      for (let c = cStart; c <= cEnd; c++) {
        cellTriLists[r * gridCols + c].push(t);
      }
    }
  }

  return cellTriLists.map((list) => new Uint32Array(list));
}

export function buildPackedWindMeshBuffer(
  device: GPUDevice,
  mesh: WindMeshFileData,
): GPUBuffer {
  const triCount = mesh.indexCount / 3;
  const cells = buildSpatialGrid(mesh);
  const numCells = mesh.gridCols * mesh.gridRows;

  // Calculate total buffer size
  const vertexU32s = mesh.vertexCount * WIND_VERTEX_FLOATS;
  const indexU32s = mesh.indexCount;
  const gridHeaderU32s = numCells * 2;
  let gridListU32s = 0;
  for (const cell of cells) {
    gridListU32s += cell.length;
  }

  const totalU32s =
    HEADER_U32S + vertexU32s + indexU32s + gridHeaderU32s + gridListU32s;

  const data = new ArrayBuffer(totalU32s * 4);
  const u32View = new Uint32Array(data);
  const f32View = new Float32Array(data);

  // Offsets
  const vertexStart = HEADER_U32S;
  const indexStart = vertexStart + vertexU32s;
  const gridHeaderStart = indexStart + indexU32s;
  const gridListStart = gridHeaderStart + gridHeaderU32s;

  // Write header
  u32View[0] = 1; // hasMesh
  u32View[1] = vertexStart;
  u32View[2] = mesh.vertexCount;
  u32View[3] = indexStart;
  u32View[4] = triCount;
  u32View[5] = gridHeaderStart;
  u32View[6] = mesh.gridCols;
  u32View[7] = mesh.gridRows;
  u32View[8] = floatToU32(mesh.gridMinX);
  u32View[9] = floatToU32(mesh.gridMinY);
  u32View[10] = floatToU32(mesh.gridCellWidth);
  u32View[11] = floatToU32(mesh.gridCellHeight);

  // Write vertex data
  for (let v = 0; v < mesh.vertexCount * WIND_VERTEX_FLOATS; v++) {
    f32View[vertexStart + v] = mesh.vertices[v];
  }

  // Write index data
  for (let i = 0; i < mesh.indexCount; i++) {
    u32View[indexStart + i] = mesh.indices[i];
  }

  // Write grid cell headers and triangle lists
  let currentGridListOffset = gridListStart;
  for (let c = 0; c < numCells; c++) {
    const cell = cells[c];
    u32View[gridHeaderStart + c * 2] = currentGridListOffset;
    u32View[gridHeaderStart + c * 2 + 1] = cell.length;

    for (let t = 0; t < cell.length; t++) {
      u32View[currentGridListOffset + t] = cell[t];
    }
    currentGridListOffset += cell.length;
  }

  const buffer = device.createBuffer({
    size: Math.max(data.byteLength, 64),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    label: "Packed Wind Mesh Buffer",
  });
  device.queue.writeBuffer(buffer, 0, data);

  return buffer;
}

export function createPlaceholderPackedWindMeshBuffer(
  device: GPUDevice,
): GPUBuffer {
  const buffer = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    label: "Placeholder Packed Wind Mesh Buffer",
  });
  const data = new Uint32Array(HEADER_U32S);
  data[0] = 0; // hasMesh = 0
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}
