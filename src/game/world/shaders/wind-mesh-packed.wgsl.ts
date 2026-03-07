/**
 * Packed wind mesh accessor functions for reading from a single array<u32> buffer.
 *
 * Multi-source buffer layout matches WindMeshPacking.ts:
 *
 * GLOBAL HEADER (32 u32s):
 *   [0]      numWindSources
 *   [1..8]   meshOffset[0..7]
 *   [9..16]  direction[0..7]      (f32 bitcast)
 *   [17..31] padding
 *
 * PER-SOURCE MESH HEADER (16 u32s each):
 *   [0]  vertexOffset    [1]  vertexCount
 *   [2]  indexOffset      [3]  triangleCount
 *   [4]  gridOffset       [5]  gridCols       [6]  gridRows
 *   [7]  gridMinX (f32)   [8]  gridMinY (f32)
 *   [9]  gridCellWidth    [10] gridCellHeight
 *   [11..15] padding
 *
 * All float values are stored as u32 and recovered via bitcast<f32>().
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";
import { fn_barycentric } from "./mesh-packed.wgsl";
import { MAX_WIND_SOURCES } from "../wind/WindConstants";

export const struct_WindMeshSourceHeader: ShaderModule = {
  preamble: /*wgsl*/ `
struct WindMeshSourceHeader {
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

export const fn_getWindMeshSourceHeader: ShaderModule = {
  dependencies: [struct_WindMeshSourceHeader],
  code: /*wgsl*/ `
fn getWindMeshSourceHeader(packed: ptr<storage, array<u32>, read>, meshOffset: u32) -> WindMeshSourceHeader {
  var h: WindMeshSourceHeader;
  h.vertexOffset = (*packed)[meshOffset + 0u];
  h.vertexCount = (*packed)[meshOffset + 1u];
  h.indexOffset = (*packed)[meshOffset + 2u];
  h.triangleCount = (*packed)[meshOffset + 3u];
  h.gridOffset = (*packed)[meshOffset + 4u];
  h.gridCols = (*packed)[meshOffset + 5u];
  h.gridRows = (*packed)[meshOffset + 6u];
  h.gridMinX = bitcast<f32>((*packed)[meshOffset + 7u]);
  h.gridMinY = bitcast<f32>((*packed)[meshOffset + 8u]);
  h.gridCellWidth = bitcast<f32>((*packed)[meshOffset + 9u]);
  h.gridCellHeight = bitcast<f32>((*packed)[meshOffset + 10u]);
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

export const fn_lookupWindMeshForSource: ShaderModule = {
  dependencies: [
    struct_WindMeshSourceHeader,
    struct_WindMeshLookupResult,
    fn_getWindMeshSourceHeader,
    fn_getWindMeshVertexPos,
    fn_getWindMeshVertexAttribs,
    fn_getWindMeshTriangle,
    fn_getWindMeshGridCell,
    fn_getWindMeshGridTriIndex,
    fn_barycentric,
  ],
  code: /*wgsl*/ `
fn lookupWindMeshForSource(
  worldPos: vec2<f32>,
  packed: ptr<storage, array<u32>, read>,
  meshOffset: u32,
) -> WindMeshLookupResult {
  var result: WindMeshLookupResult;
  result.speedFactor = 1.0;
  result.directionOffset = 0.0;
  result.turbulence = 0.0;
  result.found = false;

  let header = getWindMeshSourceHeader(packed, meshOffset);
  if (header.triangleCount == 0u) {
    return result;
  }

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

export const fn_lookupWindMeshBlended: ShaderModule = {
  dependencies: [fn_lookupWindMeshForSource, struct_WindMeshLookupResult],
  code: /*wgsl*/ `
const MAX_WIND_SOURCES: u32 = ${MAX_WIND_SOURCES}u;

fn lookupWindMeshBlended(
  worldPos: vec2<f32>,
  packed: ptr<storage, array<u32>, read>,
  weights: array<f32, ${MAX_WIND_SOURCES}>,
) -> WindMeshLookupResult {
  var result: WindMeshLookupResult;
  result.speedFactor = 1.0;
  result.directionOffset = 0.0;
  result.turbulence = 0.0;
  result.found = false;

  let numSources = (*packed)[0u];
  if (numSources == 0u) {
    return result;
  }

  var totalWeight: f32 = 0.0;
  var accSpeed: f32 = 0.0;
  var accDir: f32 = 0.0;
  var accTurb: f32 = 0.0;
  var anyFound: bool = false;

  for (var s = 0u; s < numSources && s < MAX_WIND_SOURCES; s++) {
    let w = weights[s];
    if (w <= 0.0) {
      continue;
    }

    let meshOffset = (*packed)[1u + s];
    let sourceResult = lookupWindMeshForSource(worldPos, packed, meshOffset);

    if (sourceResult.found) {
      accSpeed += sourceResult.speedFactor * w;
      accDir += sourceResult.directionOffset * w;
      accTurb += sourceResult.turbulence * w;
      totalWeight += w;
      anyFound = true;
    }
  }

  if (anyFound && totalWeight > 0.0) {
    let invWeight = 1.0 / totalWeight;
    result.speedFactor = accSpeed * invWeight;
    result.directionOffset = accDir * invWeight;
    result.turbulence = accTurb * invWeight;
    result.found = true;
  }

  return result;
}
`,
};
