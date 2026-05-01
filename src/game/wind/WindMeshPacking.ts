/**
 * CPU-side wind mesh packing for GPU compute shader access.
 *
 * Packs multi-source vertex/index data and spatial grid indices into a single
 * array<u32> buffer.
 *
 * Buffer layout:
 * GLOBAL HEADER (32 u32s):
 *   [0]      numWindSources
 *   [1..8]   meshOffset[0..7]     (u32 offset to each source's mesh header)
 *   [9..16]  direction[0..7]      (f32 bitcast, radians)
 *   [17..31] padding
 *
 * PER-SOURCE MESH HEADER (16 u32s each):
 *   vertexOffset, vertexCount, indexOffset, triangleCount,
 *   gridOffset, gridCols, gridRows,
 *   gridMinX, gridMinY, gridCellWidth, gridCellHeight,
 *   padding x5
 *
 * VERTEX DATA (5 f32-as-u32 per vertex, per source)
 * INDEX DATA (3 u32 per triangle, shared across sources)
 * GRID CELL HEADERS (2 u32 per cell: triListOffset, triListCount, per source)
 * GRID TRIANGLE LISTS (u32 triangle indices, variable length, per source)
 */

import type {
  WindMeshFileBundle,
  WindMeshSourceData,
} from "../../pipeline/mesh-building/WindmeshFile";
import { MAX_WIND_SOURCES } from "../world/wind/WindConstants";

const GLOBAL_HEADER_U32S = 32;
const MESH_HEADER_U32S = 16;
const WIND_VERTEX_FLOATS = 5;

const f32Buf = new Float32Array(1);
const u32Buf = new Uint32Array(f32Buf.buffer);
function floatToU32(f: number): number {
  f32Buf[0] = f;
  return u32Buf[0];
}

/**
 * Build a spatial grid index for a single source's mesh.
 */
function buildSpatialGrid(
  source: WindMeshSourceData,
  gridCols: number,
  gridRows: number,
  gridMinX: number,
  gridMinY: number,
  gridCellWidth: number,
  gridCellHeight: number,
): Uint32Array[] {
  const verts = source.vertices;
  const indices = source.indices;
  const triCount = source.indexCount / 3;

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

/**
 * Build the packed wind mesh data as a plain Uint32Array.
 * Used both by the GPU uploader (rendering path) and by the query
 * worker pool (which copies the buffer into shared WASM memory).
 */
export function buildPackedWindMeshData(
  bundle: WindMeshFileBundle,
): Uint32Array {
  const numSources = Math.min(bundle.sourceCount, MAX_WIND_SOURCES);
  const {
    gridCols,
    gridRows,
    gridMinX,
    gridMinY,
    gridCellWidth,
    gridCellHeight,
  } = bundle;
  const numCells = gridCols * gridRows;

  // Build spatial grids for each source
  const grids: Uint32Array[][] = [];
  for (let s = 0; s < numSources; s++) {
    grids.push(
      buildSpatialGrid(
        bundle.sources[s],
        gridCols,
        gridRows,
        gridMinX,
        gridMinY,
        gridCellWidth,
        gridCellHeight,
      ),
    );
  }

  // Calculate total buffer size
  let totalU32s = GLOBAL_HEADER_U32S + numSources * MESH_HEADER_U32S;

  // Per-source: vertex data + grid headers + grid lists
  const perSourceSizes: {
    vertexU32s: number;
    gridHeaderU32s: number;
    gridListU32s: number;
  }[] = [];
  let sharedIndexU32s = 0;

  for (let s = 0; s < numSources; s++) {
    const src = bundle.sources[s];
    const vertexU32s = src.vertexCount * WIND_VERTEX_FLOATS;
    const gridHeaderU32s = numCells * 2;
    let gridListU32s = 0;
    for (const cell of grids[s]) {
      gridListU32s += cell.length;
    }
    perSourceSizes.push({ vertexU32s, gridHeaderU32s, gridListU32s });
    totalU32s += vertexU32s + gridHeaderU32s + gridListU32s;
    if (s === 0) {
      sharedIndexU32s = src.indexCount;
    }
  }
  totalU32s += sharedIndexU32s;

  // SAB-backed so the CPU query worker pool can share without per-worker
  // copies.
  const data = new SharedArrayBuffer(totalU32s * 4);
  const u32View = new Uint32Array(data);
  const f32View = new Float32Array(data);

  // Write global header
  u32View[0] = numSources;

  // Compute mesh header offsets
  let currentOffset = GLOBAL_HEADER_U32S;
  const meshHeaderOffsets: number[] = [];
  for (let s = 0; s < numSources; s++) {
    meshHeaderOffsets.push(currentOffset);
    currentOffset += MESH_HEADER_U32S;
  }

  // Write mesh offsets and directions into global header
  for (let s = 0; s < MAX_WIND_SOURCES; s++) {
    if (s < numSources) {
      u32View[1 + s] = meshHeaderOffsets[s];
      u32View[9 + s] = floatToU32(bundle.sources[s].direction);
    } else {
      u32View[1 + s] = 0;
      u32View[9 + s] = 0;
    }
  }

  // Shared index data comes first after mesh headers
  const indexStart = currentOffset;
  for (let i = 0; i < sharedIndexU32s; i++) {
    u32View[indexStart + i] = bundle.sources[0].indices[i];
  }
  currentOffset = indexStart + sharedIndexU32s;

  // Write per-source data
  for (let s = 0; s < numSources; s++) {
    const src = bundle.sources[s];
    const { vertexU32s, gridHeaderU32s, gridListU32s } = perSourceSizes[s];
    const triCount = src.indexCount / 3;
    const grid = grids[s];

    const vertexStart = currentOffset;
    currentOffset += vertexU32s;
    const gridHeaderStart = currentOffset;
    currentOffset += gridHeaderU32s;
    const gridListStart = currentOffset;
    currentOffset += gridListU32s;

    // Write per-source mesh header
    const h = meshHeaderOffsets[s];
    u32View[h + 0] = vertexStart;
    u32View[h + 1] = src.vertexCount;
    u32View[h + 2] = indexStart; // shared
    u32View[h + 3] = triCount;
    u32View[h + 4] = gridHeaderStart;
    u32View[h + 5] = gridCols;
    u32View[h + 6] = gridRows;
    u32View[h + 7] = floatToU32(gridMinX);
    u32View[h + 8] = floatToU32(gridMinY);
    u32View[h + 9] = floatToU32(gridCellWidth);
    u32View[h + 10] = floatToU32(gridCellHeight);

    // Write vertex data
    for (let v = 0; v < src.vertexCount * WIND_VERTEX_FLOATS; v++) {
      f32View[vertexStart + v] = src.vertices[v];
    }

    // Write grid cell headers and triangle lists
    let currentGridListOffset = gridListStart;
    for (let c = 0; c < numCells; c++) {
      const cell = grid[c];
      u32View[gridHeaderStart + c * 2] = currentGridListOffset;
      u32View[gridHeaderStart + c * 2 + 1] = cell.length;

      for (let t = 0; t < cell.length; t++) {
        u32View[currentGridListOffset + t] = cell[t];
      }
      currentGridListOffset += cell.length;
    }
  }

  return u32View;
}

/** Upload a prebuilt packed wind mesh Uint32Array into a GPUBuffer. */
export function uploadPackedWindMeshBuffer(
  device: GPUDevice,
  data: Uint32Array,
  label = "Packed Wind Mesh Buffer",
): GPUBuffer {
  const buffer = device.createBuffer({
    size: Math.max(data.byteLength, 64),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    label,
  });
  device.queue.writeBuffer(
    buffer,
    0,
    data.buffer,
    data.byteOffset,
    data.byteLength,
  );
  return buffer;
}

export function buildPackedWindMeshBuffer(
  device: GPUDevice,
  bundle: WindMeshFileBundle,
): GPUBuffer {
  return uploadPackedWindMeshBuffer(device, buildPackedWindMeshData(bundle));
}

/** Placeholder packed wind mesh (no sources). SAB-backed. */
export function createPlaceholderPackedWindMeshData(): Uint32Array {
  const sab = new SharedArrayBuffer(
    GLOBAL_HEADER_U32S * Uint32Array.BYTES_PER_ELEMENT,
  );
  const data = new Uint32Array(sab);
  data[0] = 0; // numWindSources = 0
  return data;
}

export function createPlaceholderPackedWindMeshBuffer(
  device: GPUDevice,
): GPUBuffer {
  return uploadPackedWindMeshBuffer(
    device,
    createPlaceholderPackedWindMeshData(),
    "Placeholder Packed Wind Mesh Buffer",
  );
}
