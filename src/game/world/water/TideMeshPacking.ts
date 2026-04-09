/**
 * CPU-side tide mesh packing for GPU compute shader access.
 *
 * Packs tidal flow vertex/index data and spatial grid indices into a single
 * array<u32> buffer.
 *
 * Buffer layout:
 * HEADER (16 u32s):
 *   [0]  tideLevelCount
 *   [1]  vertexCount
 *   [2]  triangleCount
 *   [3]  gridCols
 *   [4]  gridRows
 *   [5]  gridMinX (f32 as u32)
 *   [6]  gridMinY (f32 as u32)
 *   [7]  gridCellWidth (f32 as u32)
 *   [8]  gridCellHeight (f32 as u32)
 *   [9]  tideLevelTableOffset (u32 offset into buffer)
 *   [10] vertexDataOffset
 *   [11] flowDataOffset
 *   [12] indexDataOffset
 *   [13] gridCellHeadersOffset
 *   [14] gridTriangleListsOffset
 *   [15] padding
 *
 * DATA SECTIONS (packed sequentially after header):
 *   Tide level table: tideLevelCount f32s (as u32 bitcast)
 *   Vertex positions: vertexCount * 2 f32s (as u32)
 *   Flow data: tideLevelCount * vertexCount * 4 f32s (as u32)
 *   Index data: triangleCount * 3 u32s
 *   Grid cell headers: gridCols * gridRows * 2 u32s
 *   Grid triangle lists: variable u32s
 */

import type { TideMeshFileData } from "../../../pipeline/mesh-building/TidemeshFile";

const HEADER_U32S = 16;

/** Float bits -> u32 for buffer packing */
function f32AsU32(f: number): number {
  const buf = new Float32Array(1);
  buf[0] = f;
  return new Uint32Array(buf.buffer)[0];
}

export function packTideMeshBuffer(data: TideMeshFileData): Uint32Array {
  const {
    tideLevels,
    vertexPositions,
    flowData,
    indices,
    vertexCount,
    triangleCount,
    gridCols,
    gridRows,
    gridMinX,
    gridMinY,
    gridCellWidth,
    gridCellHeight,
    gridCellHeaders,
    gridTriangleLists,
  } = data;

  const tideLevelCount = tideLevels.length;
  const tideLevelU32s = tideLevelCount;
  const vertexU32s = vertexCount * 2;
  const flowU32s = tideLevelCount * vertexCount * 4;
  const indexU32s = triangleCount * 3;
  const gridHeaderU32s = gridCols * gridRows * 2;
  const gridListU32s = gridTriangleLists.length;

  const totalU32s =
    HEADER_U32S +
    tideLevelU32s +
    vertexU32s +
    flowU32s +
    indexU32s +
    gridHeaderU32s +
    gridListU32s;

  const buffer = new ArrayBuffer(totalU32s * 4);
  const u32View = new Uint32Array(buffer);
  const f32View = new Float32Array(buffer);

  // Calculate offsets
  let currentOffset = HEADER_U32S;

  const tideLevelTableOffset = currentOffset;
  currentOffset += tideLevelU32s;

  const vertexDataOffset = currentOffset;
  currentOffset += vertexU32s;

  const flowDataOffset = currentOffset;
  currentOffset += flowU32s;

  const indexDataOffset = currentOffset;
  currentOffset += indexU32s;

  const gridCellHeadersOffset = currentOffset;
  currentOffset += gridHeaderU32s;

  const gridTriangleListsOffset = currentOffset;

  // Write header
  u32View[0] = tideLevelCount;
  u32View[1] = vertexCount;
  u32View[2] = triangleCount;
  u32View[3] = gridCols;
  u32View[4] = gridRows;
  u32View[5] = f32AsU32(gridMinX);
  u32View[6] = f32AsU32(gridMinY);
  u32View[7] = f32AsU32(gridCellWidth);
  u32View[8] = f32AsU32(gridCellHeight);
  u32View[9] = tideLevelTableOffset;
  u32View[10] = vertexDataOffset;
  u32View[11] = flowDataOffset;
  u32View[12] = indexDataOffset;
  u32View[13] = gridCellHeadersOffset;
  u32View[14] = gridTriangleListsOffset;
  u32View[15] = 0; // padding

  // Write tide level table
  for (let i = 0; i < tideLevelCount; i++) {
    f32View[tideLevelTableOffset + i] = tideLevels[i];
  }

  // Write vertex positions
  for (let i = 0; i < vertexCount * 2; i++) {
    f32View[vertexDataOffset + i] = vertexPositions[i];
  }

  // Write flow data
  let flowOffset = flowDataOffset;
  for (let t = 0; t < tideLevelCount; t++) {
    const tideFlowData = flowData[t];
    for (let i = 0; i < vertexCount * 4; i++) {
      f32View[flowOffset + i] = tideFlowData[i];
    }
    flowOffset += vertexCount * 4;
  }

  // Write index data
  for (let i = 0; i < triangleCount * 3; i++) {
    u32View[indexDataOffset + i] = indices[i];
  }

  // Write grid cell headers — adjust triListOffsets to be absolute u32 indices
  const cellCount = gridCols * gridRows;
  for (let i = 0; i < cellCount; i++) {
    const rawOffset = gridCellHeaders[i * 2]; // relative to grid triangle lists
    const count = gridCellHeaders[i * 2 + 1];
    u32View[gridCellHeadersOffset + i * 2] = gridTriangleListsOffset + rawOffset;
    u32View[gridCellHeadersOffset + i * 2 + 1] = count;
  }

  // Write grid triangle lists
  for (let i = 0; i < gridListU32s; i++) {
    u32View[gridTriangleListsOffset + i] = gridTriangleLists[i];
  }

  return new Uint32Array(buffer);
}

export function createPlaceholderTideMeshBuffer(): Uint32Array {
  const buffer = new Uint32Array(HEADER_U32S);
  // All zeros: tideLevelCount=0, vertexCount=0, triangleCount=0, etc.
  return buffer;
}
