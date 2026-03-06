/**
 * Packed wind mesh accessor functions for reading from a single array<u32> buffer.
 *
 * Buffer layout matches WindMeshPacking.ts:
 *
 * HEADER (16 u32s):
 *   [0]  hasMesh          [1]  vertexOffset    [2]  vertexCount
 *   [3]  indexOffset       [4]  triangleCount
 *   [5]  gridOffset        [6]  gridCols       [7]  gridRows
 *   [8]  gridMinX (f32)    [9]  gridMinY (f32)
 *   [10] gridCellWidth     [11] gridCellHeight
 *   [12..15] padding
 *
 * All float values are stored as u32 and recovered via bitcast<f32>().
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";
import { fn_barycentric } from "./mesh-packed.wgsl";

export const struct_WindMeshHeader: ShaderModule = {
  preamble: /*wgsl*/ `
struct WindMeshHeader {
  hasMesh: u32,
  vertexOffset: u32,
  vertexCount: u32,
  indexOffset: u32,
  triangleCount: u32,
  gridOffset: u32,
  gridCols: u32,
  gridRows: u32,
  gridMinX: f32,
  gridMinY: f32,
  gridCellWidth: f32,
  gridCellHeight: f32,
}
`,
  code: "",
};

export const struct_WindMeshLookupResult: ShaderModule = {
  preamble: /*wgsl*/ `
struct WindMeshLookupResult {
  speedFactor: f32,
  directionOffset: f32,
  turbulence: f32,
  found: bool,
}
`,
  code: "",
};

export const fn_getWindMeshHeader: ShaderModule = {
  dependencies: [struct_WindMeshHeader],
  code: /*wgsl*/ `
fn getWindMeshHeader(packed: ptr<storage, array<u32>, read>) -> WindMeshHeader {
  var h: WindMeshHeader;
  h.hasMesh = (*packed)[0u];
  h.vertexOffset = (*packed)[1u];
  h.vertexCount = (*packed)[2u];
  h.indexOffset = (*packed)[3u];
  h.triangleCount = (*packed)[4u];
  h.gridOffset = (*packed)[5u];
  h.gridCols = (*packed)[6u];
  h.gridRows = (*packed)[7u];
  h.gridMinX = bitcast<f32>((*packed)[8u]);
  h.gridMinY = bitcast<f32>((*packed)[9u]);
  h.gridCellWidth = bitcast<f32>((*packed)[10u]);
  h.gridCellHeight = bitcast<f32>((*packed)[11u]);
  return h;
}
`,
};

export const fn_getWindMeshVertexPos: ShaderModule = {
  code: /*wgsl*/ `
fn getWindMeshVertexPos(packed: ptr<storage, array<u32>, read>, vertexOffset: u32, index: u32) -> vec2<f32> {
  let base = vertexOffset + index * 5u;
  return vec2<f32>(
    bitcast<f32>((*packed)[base]),
    bitcast<f32>((*packed)[base + 1u])
  );
}
`,
};

export const fn_getWindMeshVertexAttribs: ShaderModule = {
  code: /*wgsl*/ `
fn getWindMeshVertexAttribs(packed: ptr<storage, array<u32>, read>, vertexOffset: u32, index: u32) -> vec3<f32> {
  let base = vertexOffset + index * 5u + 2u;
  return vec3<f32>(
    bitcast<f32>((*packed)[base]),
    bitcast<f32>((*packed)[base + 1u]),
    bitcast<f32>((*packed)[base + 2u])
  );
}
`,
};

export const fn_getWindMeshTriangle: ShaderModule = {
  code: /*wgsl*/ `
fn getWindMeshTriangle(packed: ptr<storage, array<u32>, read>, indexOffset: u32, triIndex: u32) -> vec3<u32> {
  let base = indexOffset + triIndex * 3u;
  return vec3<u32>(
    (*packed)[base],
    (*packed)[base + 1u],
    (*packed)[base + 2u]
  );
}
`,
};

export const fn_getWindMeshGridCell: ShaderModule = {
  code: /*wgsl*/ `
fn getWindMeshGridCell(packed: ptr<storage, array<u32>, read>, gridOffset: u32, cellIndex: u32) -> vec2<u32> {
  let base = gridOffset + cellIndex * 2u;
  return vec2<u32>(
    (*packed)[base],
    (*packed)[base + 1u]
  );
}
`,
};

export const fn_getWindMeshGridTriIndex: ShaderModule = {
  code: /*wgsl*/ `
fn getWindMeshGridTriIndex(packed: ptr<storage, array<u32>, read>, listOffset: u32) -> u32 {
  return (*packed)[listOffset];
}
`,
};

export const fn_lookupWindMesh: ShaderModule = {
  dependencies: [
    struct_WindMeshHeader,
    struct_WindMeshLookupResult,
    fn_getWindMeshHeader,
    fn_getWindMeshVertexPos,
    fn_getWindMeshVertexAttribs,
    fn_getWindMeshTriangle,
    fn_getWindMeshGridCell,
    fn_getWindMeshGridTriIndex,
    fn_barycentric,
  ],
  code: /*wgsl*/ `
fn lookupWindMesh(
  worldPos: vec2<f32>,
  packed: ptr<storage, array<u32>, read>,
) -> WindMeshLookupResult {
  var result: WindMeshLookupResult;
  result.speedFactor = 1.0;
  result.directionOffset = 0.0;
  result.turbulence = 0.0;
  result.found = false;

  let header = getWindMeshHeader(packed);
  if (header.hasMesh == 0u || header.triangleCount == 0u) {
    return result;
  }

  // Axis-aligned grid lookup (no rotation needed)
  let gx = (worldPos.x - header.gridMinX) / header.gridCellWidth;
  let gy = (worldPos.y - header.gridMinY) / header.gridCellHeight;

  let col = i32(floor(gx));
  let row = i32(floor(gy));

  if (col < 0 || col >= i32(header.gridCols) || row < 0 || row >= i32(header.gridRows)) {
    return result;
  }

  let cellIndex = u32(row) * header.gridCols + u32(col);
  let cell = getWindMeshGridCell(packed, header.gridOffset, cellIndex);
  let triListOffset = cell.x;
  let triListCount = cell.y;

  for (var t = 0u; t < triListCount; t++) {
    let triIndex = getWindMeshGridTriIndex(packed, triListOffset + t);
    let tri = getWindMeshTriangle(packed, header.indexOffset, triIndex);

    let a = getWindMeshVertexPos(packed, header.vertexOffset, tri.x);
    let b = getWindMeshVertexPos(packed, header.vertexOffset, tri.y);
    let c = getWindMeshVertexPos(packed, header.vertexOffset, tri.z);

    let bary = barycentric(worldPos, a, b, c);

    if (bary.x >= -0.001 && bary.y >= -0.001 && bary.z >= -0.001) {
      let attribA = getWindMeshVertexAttribs(packed, header.vertexOffset, tri.x);
      let attribB = getWindMeshVertexAttribs(packed, header.vertexOffset, tri.y);
      let attribC = getWindMeshVertexAttribs(packed, header.vertexOffset, tri.z);

      let interp = attribA * bary.x + attribB * bary.y + attribC * bary.z;

      result.speedFactor = interp.x;
      result.directionOffset = interp.y;
      result.turbulence = interp.z;
      result.found = true;
      return result;
    }
  }

  return result;
}
`,
};
