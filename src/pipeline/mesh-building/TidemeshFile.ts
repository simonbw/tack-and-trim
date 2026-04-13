/**
 * Binary .tidemesh file format for prebuilt tidal flow mesh data.
 *
 * Format:
 *   Header (64 bytes):
 *     [0..3]    magic: u32 = 0x4D444954 ("TIDM" LE)
 *     [4..5]    version: u16 = 1
 *     [6..7]    tideLevelCount: u16
 *     [8..11]   inputHash[0]: u32
 *     [12..15]  inputHash[1]: u32
 *     [16..19]  vertexCount: u32
 *     [20..23]  triangleCount: u32
 *     [24..27]  gridCols: u32
 *     [28..31]  gridRows: u32
 *     [32..35]  gridMinX: f32
 *     [36..39]  gridMinY: f32
 *     [40..43]  gridCellWidth: f32
 *     [44..47]  gridCellHeight: f32
 *     [48..63]  reserved
 *
 *   Tide level table (4 bytes x tideLevelCount):
 *     tideHeight: f32
 *
 *   Vertex position data (2 f32 per vertex):
 *     x, y
 *
 *   Flow data (tideLevelCount * vertexCount * 4 f32):
 *     For each tide level, for each vertex: vx_a, vy_a, vx_b, vy_b
 *
 *   Index data (3 u32 per triangle):
 *     i0, i1, i2
 *
 *   Grid cell headers (2 u32 per cell, gridCols * gridRows cells):
 *     triListOffset, triListCount
 *
 *   Grid triangle lists (u32 per entry):
 *     triangleIndex
 */

const MAGIC = 0x4d444954; // "TIDM" as little-endian u32
const HEADER_BYTES = 64;

export interface TideMeshFileData {
  tideLevels: Float32Array;
  vertexPositions: Float32Array; // vertexCount * 2
  flowData: Float32Array[]; // tideLevelCount arrays, each vertexCount * 4
  indices: Uint32Array; // triangleCount * 3
  vertexCount: number;
  triangleCount: number;
  gridCols: number;
  gridRows: number;
  gridMinX: number;
  gridMinY: number;
  gridCellWidth: number;
  gridCellHeight: number;
  gridCellHeaders: Uint32Array; // (gridCols * gridRows) * 2
  gridTriangleLists: Uint32Array;
}

export function parseTidemeshBuffer(buffer: ArrayBuffer): TideMeshFileData {
  const view = new DataView(buffer);

  const magic = view.getUint32(0, true);
  if (magic !== MAGIC) {
    throw new Error(
      `Invalid tidemesh magic: 0x${magic.toString(16)} (expected 0x${MAGIC.toString(16)})`,
    );
  }

  const version = view.getUint16(4, true);
  if (version !== 1) {
    throw new Error(`Unsupported tidemesh version: ${version}`);
  }

  const tideLevelCount = view.getUint16(6, true);
  const vertexCount = view.getUint32(16, true);
  const triangleCount = view.getUint32(20, true);
  const gridCols = view.getUint32(24, true);
  const gridRows = view.getUint32(28, true);
  const gridMinX = view.getFloat32(32, true);
  const gridMinY = view.getFloat32(36, true);
  const gridCellWidth = view.getFloat32(40, true);
  const gridCellHeight = view.getFloat32(44, true);

  let offset = HEADER_BYTES;

  // Tide level table
  const tideLevels = new Float32Array(buffer, offset, tideLevelCount);
  offset += tideLevelCount * 4;

  // Vertex positions
  const vertexPositions = new Float32Array(buffer, offset, vertexCount * 2);
  offset += vertexCount * 2 * 4;

  // Flow data: tideLevelCount arrays, each vertexCount * 4 floats
  const flowData: Float32Array[] = [];
  for (let t = 0; t < tideLevelCount; t++) {
    const floatCount = vertexCount * 4;
    flowData.push(new Float32Array(buffer, offset, floatCount));
    offset += floatCount * 4;
  }

  // Index data
  const indexCount = triangleCount * 3;
  const indices = new Uint32Array(buffer, offset, indexCount);
  offset += indexCount * 4;

  // Grid cell headers
  const numCells = gridCols * gridRows;
  const gridCellHeaders = new Uint32Array(buffer, offset, numCells * 2);
  offset += numCells * 2 * 4;

  // Grid triangle lists (remaining data)
  const remainingU32s = (buffer.byteLength - offset) / 4;
  const gridTriangleLists = new Uint32Array(buffer, offset, remainingU32s);

  return {
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
  };
}
