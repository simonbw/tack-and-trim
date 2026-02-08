/**
 * Packed terrain accessor functions for reading from a single array<u32> buffer.
 *
 * The packed terrain buffer layout:
 * [0] verticesOffset - element index where vertex data starts
 * [1] contoursOffset - element index where contour data starts
 * [2] childrenOffset - element index where children data starts
 * [...] vertex data (f32 pairs stored as u32)
 * [...] contour data (13 fields per contour, mixed u32/f32)
 * [...] children data (u32 indices)
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
      skipCount: u32,  // Number of contours in subtree (for DFS skip traversal)
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
