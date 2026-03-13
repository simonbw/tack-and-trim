/**
 * Packed terrain accessor functions for reading from a single array<u32> buffer.
 *
 * The packed terrain buffer layout:
 * [0] verticesOffset - element index where vertex data starts
 * [1] contoursOffset - element index where contour data starts
 * [2] childrenOffset - element index where children data starts
 * [3] containmentGridOffset - element index where containment grid data starts
 * [4] idwGridDataOffset - element index where IDW grid data starts
 * [...] vertex data (f32 pairs stored as u32)
 * [...] contour data (14 fields per contour, mixed u32/f32)
 * [...] children data (u32 indices)
 * [...] containment grid data (256 u32 per contour, 2-bit packed flags)
 * [...] IDW grid data (variable, prefix-sum cell_starts + packed entries)
 *
 * All float values are stored as u32 and recovered via bitcast<f32>().
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";
import { FLOATS_PER_CONTOUR } from "../terrain/LandMass";

/**
 * Contour data structure for terrain height computation.
 * Defined here (not in terrain.wgsl) to avoid circular imports.
 */
export const struct_ContourData: ShaderModule = {
  code: /*wgsl*/ `
    struct ContourData {
      pointStartIndex: u32,
      pointCount: u32,
      height: f32,
      parentIndex: i32,
      depth: u32,
      childStartIndex: u32,
      childCount: u32,
      isCoastline: u32,
      bboxMinX: f32,
      bboxMinY: f32,
      bboxMaxX: f32,
      bboxMaxY: f32,
      skipCount: u32,           // Number of contours in subtree (for DFS skip traversal)
      idwGridDataOffset: u32,   // Absolute offset in packed buffer for IDW grid (0 = no grid)
    }
  `,
};

/**
 * Read a terrain vertex (vec2<f32>) from the packed buffer.
 */
export const fn_getTerrainVertex: ShaderModule = {
  code: /*wgsl*/ `
fn getTerrainVertex(packed: ptr<storage, array<u32>, read>, index: u32) -> vec2<f32> {
  let offset = (*packed)[0u]; // verticesOffset
  let base = offset + index * 2u;
  return vec2<f32>(
    bitcast<f32>((*packed)[base]),
    bitcast<f32>((*packed)[base + 1u])
  );
}
`,
};

/**
 * Read contour data from the packed buffer.
 * Reads 13 consecutive u32 values and reconstructs the ContourData struct.
 */
export const fn_getContourData: ShaderModule = {
  dependencies: [struct_ContourData],
  code: /*wgsl*/ `
fn getContourData(packed: ptr<storage, array<u32>, read>, contourIndex: u32) -> ContourData {
  let offset = (*packed)[1u]; // contoursOffset
  let base = offset + contourIndex * ${FLOATS_PER_CONTOUR}u;
  var c: ContourData;
  c.pointStartIndex = (*packed)[base + 0u];
  c.pointCount = (*packed)[base + 1u];
  c.height = bitcast<f32>((*packed)[base + 2u]);
  c.parentIndex = bitcast<i32>((*packed)[base + 3u]);
  c.depth = (*packed)[base + 4u];
  c.childStartIndex = (*packed)[base + 5u];
  c.childCount = (*packed)[base + 6u];
  c.isCoastline = (*packed)[base + 7u];
  c.bboxMinX = bitcast<f32>((*packed)[base + 8u]);
  c.bboxMinY = bitcast<f32>((*packed)[base + 9u]);
  c.bboxMaxX = bitcast<f32>((*packed)[base + 10u]);
  c.bboxMaxY = bitcast<f32>((*packed)[base + 11u]);
  c.skipCount = (*packed)[base + 12u];
  c.idwGridDataOffset = (*packed)[base + 13u];
  return c;
}
`,
};

/**
 * Read a child contour index from the packed buffer.
 */
export const fn_getTerrainChild: ShaderModule = {
  code: /*wgsl*/ `
fn getTerrainChild(packed: ptr<storage, array<u32>, read>, index: u32) -> u32 {
  let offset = (*packed)[2u]; // childrenOffset
  return (*packed)[offset + index];
}
`,
};

/**
 * Read a 2-bit containment grid cell flag from the packed buffer.
 * Returns 0 (OUTSIDE), 1 (INSIDE), or 2 (BOUNDARY).
 *
 * Each contour has a 64x64 grid = 4096 cells, packed as 2 bits per cell
 * (16 cells per u32, 256 u32s per contour).
 */
export const fn_getContainmentCellFlag: ShaderModule = {
  code: /*wgsl*/ `
fn getContainmentCellFlag(packed: ptr<storage, array<u32>, read>, contourIndex: u32, cellIndex: u32) -> u32 {
  let gridOffset = (*packed)[3u]; // containmentGridOffset
  let contourGridBase = gridOffset + contourIndex * 256u;
  let wordIndex = cellIndex >> 4u;  // cellIndex / 16
  let word = (*packed)[contourGridBase + wordIndex];
  return (word >> ((cellIndex & 15u) * 2u)) & 3u;
}
`,
};

/**
 * Get the candidate range (start, end) for an IDW grid cell.
 * gridBase is the contour's idwGridDataOffset.
 * Returns vec2<u32>(entryStart, entryEnd) as indices into the entries array.
 */
export const fn_getIDWGridCandidateRange: ShaderModule = {
  code: /*wgsl*/ `
fn getIDWGridCandidateRange(packed: ptr<storage, array<u32>, read>, gridBase: u32, cellIndex: u32) -> vec2<u32> {
  let entryStart = (*packed)[gridBase + cellIndex];
  let entryEnd = (*packed)[gridBase + cellIndex + 1u];
  return vec2<u32>(entryStart, entryEnd);
}
`,
};

/**
 * Get a packed IDW grid entry at a given index.
 * Returns packed u32: high 16 bits = contour tag, low 16 bits = edge index.
 */
export const fn_getIDWGridEntry: ShaderModule = {
  code: /*wgsl*/ `
fn getIDWGridEntry(packed: ptr<storage, array<u32>, read>, gridBase: u32, entryIndex: u32) -> u32 {
  let entriesBase = gridBase + 257u;  // after 257 cell_starts
  return (*packed)[entriesBase + entryIndex];
}
`,
};
