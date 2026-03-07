/**
 * Binary .windmesh file format for prebuilt wind mesh data.
 *
 * Version 2 format (multi-source):
 *   Header (32 bytes):
 *     [0..3]   magic: "WNDM" (ASCII LE)
 *     [4..5]   version: u16 = 2
 *     [6..7]   sourceCount: u16
 *     [8..11]  inputHashHi: u32
 *     [12..15] inputHashLo: u32
 *     [16..31] reserved
 *
 *   Per-source direction table (4 bytes x sourceCount):
 *     direction: f32 (radians)
 *
 *   Per-source entry table (16 bytes x sourceCount):
 *     vertexDataOffset, vertexCount, indexDataOffset, indexCount (all u32)
 *
 *   Shared grid metadata (32 bytes):
 *     gridCols, gridRows, gridMinX, gridMinY, gridCellWidth, gridCellHeight, reserved x2
 *
 *   Data sections (concatenated):
 *     Vertex data per source (5 f32/vertex)
 *     Index data (shared)
 */

const MAGIC = 0x4d444e57; // "WNDM" as little-endian u32
const V2_HEADER_BYTES = 32;

/**
 * Per-source wind mesh data.
 */
export interface WindMeshSourceData {
  direction: number;
  vertices: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  indexCount: number;
}

/**
 * Multi-source wind mesh bundle.
 */
export interface WindMeshFileBundle {
  sources: WindMeshSourceData[];
  sourceCount: number;
  gridCols: number;
  gridRows: number;
  gridMinX: number;
  gridMinY: number;
  gridCellWidth: number;
  gridCellHeight: number;
}

/**
 * Legacy single-source data (kept for backward compat with version 1).
 */
export interface WindMeshFileData {
  vertices: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  indexCount: number;
  gridCols: number;
  gridRows: number;
  gridMinX: number;
  gridMinY: number;
  gridCellWidth: number;
  gridCellHeight: number;
}

function parseV1(buffer: ArrayBuffer): WindMeshFileBundle {
  const view = new DataView(buffer);
  const headerBytes = 16;
  const metadataBytes = 32;

  const metaOffset = headerBytes;
  const vertexCount = view.getUint32(metaOffset, true);
  const indexCount = view.getUint32(metaOffset + 4, true);
  const gridCols = view.getUint32(metaOffset + 8, true);
  const gridRows = view.getUint32(metaOffset + 12, true);
  const gridMinX = view.getFloat32(metaOffset + 16, true);
  const gridMinY = view.getFloat32(metaOffset + 20, true);
  const gridCellWidth = view.getFloat32(metaOffset + 24, true);
  const gridCellHeight = view.getFloat32(metaOffset + 28, true);

  const dataStart = headerBytes + metadataBytes;
  const vertices = new Float32Array(buffer, dataStart, vertexCount * 5);
  const indexStart = dataStart + vertexCount * 5 * 4;
  const indices = new Uint32Array(buffer, indexStart, indexCount);

  // Default direction for v1: PI/4 (NE)
  const direction = Math.PI / 4;

  return {
    sources: [{ direction, vertices, indices, vertexCount, indexCount }],
    sourceCount: 1,
    gridCols,
    gridRows,
    gridMinX,
    gridMinY,
    gridCellWidth,
    gridCellHeight,
  };
}

function parseV2(buffer: ArrayBuffer): WindMeshFileBundle {
  const view = new DataView(buffer);

  const sourceCount = view.getUint16(6, true);

  const dirTableStart = V2_HEADER_BYTES;
  const dirTableBytes = sourceCount * 4;
  const entryTableStart = dirTableStart + dirTableBytes;
  const entryTableBytes = sourceCount * 16;
  const gridMetaStart = entryTableStart + entryTableBytes;

  // Shared grid metadata
  const gridCols = view.getUint32(gridMetaStart, true);
  const gridRows = view.getUint32(gridMetaStart + 4, true);
  const gridMinX = view.getFloat32(gridMetaStart + 8, true);
  const gridMinY = view.getFloat32(gridMetaStart + 12, true);
  const gridCellWidth = view.getFloat32(gridMetaStart + 16, true);
  const gridCellHeight = view.getFloat32(gridMetaStart + 20, true);

  const sources: WindMeshSourceData[] = [];
  for (let i = 0; i < sourceCount; i++) {
    const direction = view.getFloat32(dirTableStart + i * 4, true);

    const entryOff = entryTableStart + i * 16;
    const vertexDataOffset = view.getUint32(entryOff, true);
    const vertexCount = view.getUint32(entryOff + 4, true);
    const indexDataOffset = view.getUint32(entryOff + 8, true);
    const indexCount = view.getUint32(entryOff + 12, true);

    const vertices = new Float32Array(
      buffer,
      vertexDataOffset,
      vertexCount * 5,
    );
    const indices = new Uint32Array(buffer, indexDataOffset, indexCount);

    sources.push({ direction, vertices, indices, vertexCount, indexCount });
  }

  return {
    sources,
    sourceCount,
    gridCols,
    gridRows,
    gridMinX,
    gridMinY,
    gridCellWidth,
    gridCellHeight,
  };
}

export function parseWindmeshBuffer(buffer: ArrayBuffer): WindMeshFileBundle {
  const view = new DataView(buffer);

  const magic = view.getUint32(0, true);
  if (magic !== MAGIC) {
    throw new Error(
      `Invalid windmesh magic: 0x${magic.toString(16)} (expected 0x${MAGIC.toString(16)})`,
    );
  }

  const version = view.getUint16(4, true);
  if (version === 1) {
    return parseV1(buffer);
  }
  if (version === 2) {
    return parseV2(buffer);
  }
  throw new Error(`Unsupported windmesh version: ${version}`);
}
