/**
 * Binary .wavemesh file format for prebuilt wave mesh data.
 *
 * Format:
 *   Header (32 bytes):
 *     [0..3]   magic: "WVMH" (ASCII)
 *     [4..5]   version: u16 = 1
 *     [6..7]   waveSourceCount: u16
 *     [8..11]  inputHashHi: u32
 *     [12..15] inputHashLo: u32
 *     [16..31] reserved
 *
 *   Per-wave entry table (16 bytes × waveSourceCount):
 *     vertexDataOffset: u32, vertexCount: u32, indexDataOffset: u32, indexCount: u32
 *
 *   Coverage quad table (36 bytes × waveSourceCount):
 *     hasCoverageQuad: u32, then 8 × f32 (x0,y0,...,x3,y3)
 *
 *   Data sections (concatenated):
 *     Vertex arrays: Float32Array (6 f32/vertex)
 *     Index arrays: Uint32Array
 */

import type { CoverageQuad, WavefrontMeshData } from "./MeshBuildTypes";

const MAGIC = 0x484d5657; // "WVMH" as little-endian u32
const VERSION = 1;
const HEADER_BYTES = 32;
const ENTRY_BYTES = 16; // 4 × u32
const COVERAGE_BYTES = 36; // 1 × u32 + 8 × f32

/** A 64-bit hash stored as two 32-bit halves */
export type InputHash = [hi: number, lo: number];

/**
 * Build a .wavemesh binary buffer from an array of mesh data.
 */
export function buildWavemeshBuffer(
  meshes: WavefrontMeshData[],
  inputHash: InputHash = [0, 0],
): ArrayBuffer {
  const waveCount = meshes.length;

  // Calculate data section sizes
  let dataSize = 0;
  const vertexOffsets: number[] = [];
  const indexOffsets: number[] = [];

  for (const mesh of meshes) {
    vertexOffsets.push(dataSize);
    dataSize += mesh.vertexCount * 6 * 4; // 6 f32 per vertex
    indexOffsets.push(dataSize);
    dataSize += mesh.indexCount * 4; // u32 per index
  }

  const tableStart = HEADER_BYTES;
  const coverageStart = tableStart + ENTRY_BYTES * waveCount;
  const dataStart = coverageStart + COVERAGE_BYTES * waveCount;
  const totalSize = dataStart + dataSize;

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);

  // Write header
  view.setUint32(0, MAGIC, true);
  view.setUint16(4, VERSION, true);
  view.setUint16(6, waveCount, true);
  view.setUint32(8, inputHash[0], true);
  view.setUint32(12, inputHash[1], true);
  // bytes 16..31 reserved (already zeroed)

  // Write entry table and coverage quads
  for (let i = 0; i < waveCount; i++) {
    const mesh = meshes[i];
    const entryOffset = tableStart + i * ENTRY_BYTES;
    view.setUint32(entryOffset + 0, dataStart + vertexOffsets[i], true);
    view.setUint32(entryOffset + 4, mesh.vertexCount, true);
    view.setUint32(entryOffset + 8, dataStart + indexOffsets[i], true);
    view.setUint32(entryOffset + 12, mesh.indexCount, true);

    // Coverage quad
    const covOffset = coverageStart + i * COVERAGE_BYTES;
    if (mesh.coverageQuad) {
      view.setUint32(covOffset, 1, true);
      const q = mesh.coverageQuad;
      view.setFloat32(covOffset + 4, q.x0, true);
      view.setFloat32(covOffset + 8, q.y0, true);
      view.setFloat32(covOffset + 12, q.x1, true);
      view.setFloat32(covOffset + 16, q.y1, true);
      view.setFloat32(covOffset + 20, q.x2, true);
      view.setFloat32(covOffset + 24, q.y2, true);
      view.setFloat32(covOffset + 28, q.x3, true);
      view.setFloat32(covOffset + 32, q.y3, true);
    }
    // else: already zeroed (hasCoverageQuad = 0)

    // Copy vertex data
    const vertSrc = new Uint8Array(
      mesh.vertices.buffer,
      mesh.vertices.byteOffset,
      mesh.vertexCount * 6 * 4,
    );
    u8.set(vertSrc, dataStart + vertexOffsets[i]);

    // Copy index data
    const idxSrc = new Uint8Array(
      mesh.indices.buffer,
      mesh.indices.byteOffset,
      mesh.indexCount * 4,
    );
    u8.set(idxSrc, dataStart + indexOffsets[i]);
  }

  return buffer;
}

/**
 * Parse a .wavemesh binary buffer back into mesh data.
 */
export function parseWavemeshBuffer(buffer: ArrayBuffer): {
  meshes: WavefrontMeshData[];
  inputHash: InputHash;
} {
  const view = new DataView(buffer);

  // Validate header
  const magic = view.getUint32(0, true);
  if (magic !== MAGIC) {
    throw new Error(
      `Invalid wavemesh magic: 0x${magic.toString(16)} (expected 0x${MAGIC.toString(16)})`,
    );
  }

  const version = view.getUint16(4, true);
  if (version !== VERSION) {
    throw new Error(`Unsupported wavemesh version: ${version}`);
  }

  const waveCount = view.getUint16(6, true);
  const inputHash: InputHash = [
    view.getUint32(8, true),
    view.getUint32(12, true),
  ];

  const tableStart = HEADER_BYTES;
  const coverageStart = tableStart + ENTRY_BYTES * waveCount;

  const meshes: WavefrontMeshData[] = [];

  for (let i = 0; i < waveCount; i++) {
    const entryOffset = tableStart + i * ENTRY_BYTES;
    const vertexDataOffset = view.getUint32(entryOffset + 0, true);
    const vertexCount = view.getUint32(entryOffset + 4, true);
    const indexDataOffset = view.getUint32(entryOffset + 8, true);
    const indexCount = view.getUint32(entryOffset + 12, true);

    // Read coverage quad
    const covOffset = coverageStart + i * COVERAGE_BYTES;
    const hasCoverageQuad = view.getUint32(covOffset, true);
    let coverageQuad: CoverageQuad | null = null;
    if (hasCoverageQuad) {
      coverageQuad = {
        x0: view.getFloat32(covOffset + 4, true),
        y0: view.getFloat32(covOffset + 8, true),
        x1: view.getFloat32(covOffset + 12, true),
        y1: view.getFloat32(covOffset + 16, true),
        x2: view.getFloat32(covOffset + 20, true),
        y2: view.getFloat32(covOffset + 24, true),
        x3: view.getFloat32(covOffset + 28, true),
        y3: view.getFloat32(covOffset + 32, true),
      };
    }

    // Create typed array views into the buffer
    const vertices = new Float32Array(
      buffer,
      vertexDataOffset,
      vertexCount * 6,
    );
    const indices = new Uint32Array(buffer, indexDataOffset, indexCount);

    meshes.push({
      vertices,
      indices,
      vertexCount,
      indexCount,
      coverageQuad,
    });
  }

  return { meshes, inputHash };
}

// ─── Input Hash ──────────────────────────────────────────────────────

/**
 * FNV-1a 32-bit hash over arbitrary byte arrays.
 * Returns two independent 32-bit hashes (using different seeds)
 * packed as an InputHash tuple for ~64-bit collision resistance.
 */
export function computeInputHash(
  waveSources: Array<{
    wavelength: number;
    direction: number;
    amplitude: number;
    sourceDist: number;
    sourceOffsetX: number;
    sourceOffsetY: number;
  }>,
  terrain: {
    vertexData: Float32Array;
    contourData: ArrayBuffer;
    childrenData: Uint32Array;
    contourCount: number;
    defaultDepth: number;
  },
  tideHeight: number,
): InputHash {
  const parts: ArrayBuffer[] = [
    terrain.vertexData.buffer as ArrayBuffer,
    terrain.contourData as ArrayBuffer,
    terrain.childrenData.buffer as ArrayBuffer,
    numberToBuffer(terrain.contourCount),
    numberToBuffer(terrain.defaultDepth),
    numberToBuffer(tideHeight),
  ];

  for (const ws of waveSources) {
    parts.push(numberToBuffer(ws.wavelength));
    parts.push(numberToBuffer(ws.direction));
    parts.push(numberToBuffer(ws.amplitude));
    parts.push(numberToBuffer(ws.sourceDist));
    parts.push(numberToBuffer(ws.sourceOffsetX));
    parts.push(numberToBuffer(ws.sourceOffsetY));
  }

  // Two FNV-1a passes with different offset bases for ~64-bit resistance
  return [fnv1a32(parts, 0x811c9dc5), fnv1a32(parts, 0x050c5d1f)];
}

/** FNV-1a 32-bit hash */
function fnv1a32(parts: ArrayBuffer[], offsetBasis: number): number {
  let h = offsetBasis;
  for (const buf of parts) {
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193);
    }
  }
  return h >>> 0;
}

/** Encode a number as 8 bytes (Float64) for hashing */
function numberToBuffer(n: number): ArrayBuffer {
  const buf = new ArrayBuffer(8);
  new Float64Array(buf)[0] = n;
  return buf;
}
