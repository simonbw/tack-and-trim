/**
 * Binary .trees file format for prebuilt tree position data.
 *
 * Format:
 *   Header (16 bytes):
 *     [0..3]   magic: "TREE" (ASCII LE) = 0x45455254
 *     [4..5]   version: u16 = 1
 *     [6..7]   reserved: u16 = 0
 *     [8..11]  treeCount: u32
 *     [12..15] reserved: u32 = 0
 *
 *   Tree data (8 bytes per tree):
 *     x: f32 (world feet)
 *     y: f32 (world feet)
 */

const MAGIC = 0x45455254; // "TREE" as little-endian u32
const HEADER_BYTES = 16;
const BYTES_PER_TREE = 8;

export interface TreeFileData {
  positions: [number, number][];
}

export function parseTreeBuffer(buffer: ArrayBuffer): TreeFileData {
  const view = new DataView(buffer);

  if (buffer.byteLength < HEADER_BYTES) {
    throw new Error(
      `Tree file too small: ${buffer.byteLength} bytes (need at least ${HEADER_BYTES})`,
    );
  }

  const magic = view.getUint32(0, true);
  if (magic !== MAGIC) {
    throw new Error(
      `Invalid tree file magic: 0x${magic.toString(16)} (expected 0x${MAGIC.toString(16)})`,
    );
  }

  const version = view.getUint16(4, true);
  if (version !== 1) {
    throw new Error(`Unsupported tree file version: ${version}`);
  }

  const treeCount = view.getUint32(8, true);
  const expectedSize = HEADER_BYTES + treeCount * BYTES_PER_TREE;
  if (buffer.byteLength < expectedSize) {
    throw new Error(
      `Tree file truncated: ${buffer.byteLength} bytes (expected ${expectedSize} for ${treeCount} trees)`,
    );
  }

  const positions: [number, number][] = new Array(treeCount);
  for (let i = 0; i < treeCount; i++) {
    const offset = HEADER_BYTES + i * BYTES_PER_TREE;
    positions[i] = [
      view.getFloat32(offset, true),
      view.getFloat32(offset + 4, true),
    ];
  }

  return { positions };
}
