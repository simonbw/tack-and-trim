/**
 * Binary .windmesh file format for prebuilt wind mesh data.
 *
 * Format:
 *   Header (16 bytes):
 *     [0..3]   magic: "WNDM" (ASCII LE)
 *     [4..5]   version: u16 = 1
 *     [6..7]   reserved: u16
 *     [8..11]  inputHashHi: u32
 *     [12..15] inputHashLo: u32
 *
 *   Mesh metadata (32 bytes):
 *     vertexCount: u32, indexCount: u32,
 *     gridCols: u32, gridRows: u32,
 *     gridMinX: f32, gridMinY: f32,
 *     gridCellWidth: f32, gridCellHeight: f32
 *
 *   Vertex data: vertexCount * 5 * 4 bytes (f32 LE)
 *   Index data: indexCount * 4 bytes (u32 LE)
 */

const MAGIC = 0x4d444e57; // "WNDM" as little-endian u32
const VERSION = 1;
const HEADER_BYTES = 16;
const METADATA_BYTES = 32;

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

export function parseWindmeshBuffer(buffer: ArrayBuffer): WindMeshFileData {
  const view = new DataView(buffer);

  const magic = view.getUint32(0, true);
  if (magic !== MAGIC) {
    throw new Error(
      `Invalid windmesh magic: 0x${magic.toString(16)} (expected 0x${MAGIC.toString(16)})`,
    );
  }

  const version = view.getUint16(4, true);
  if (version !== VERSION) {
    throw new Error(`Unsupported windmesh version: ${version}`);
  }

  const metaOffset = HEADER_BYTES;
  const vertexCount = view.getUint32(metaOffset, true);
  const indexCount = view.getUint32(metaOffset + 4, true);
  const gridCols = view.getUint32(metaOffset + 8, true);
  const gridRows = view.getUint32(metaOffset + 12, true);
  const gridMinX = view.getFloat32(metaOffset + 16, true);
  const gridMinY = view.getFloat32(metaOffset + 20, true);
  const gridCellWidth = view.getFloat32(metaOffset + 24, true);
  const gridCellHeight = view.getFloat32(metaOffset + 28, true);

  const dataStart = HEADER_BYTES + METADATA_BYTES;
  const vertices = new Float32Array(buffer, dataStart, vertexCount * 5);
  const indexStart = dataStart + vertexCount * 5 * 4;
  const indices = new Uint32Array(buffer, indexStart, indexCount);

  return {
    vertices,
    indices,
    vertexCount,
    indexCount,
    gridCols,
    gridRows,
    gridMinX,
    gridMinY,
    gridCellWidth,
    gridCellHeight,
  };
}
