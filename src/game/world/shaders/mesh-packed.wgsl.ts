/**
 * Packed wavefront mesh accessor functions for reading from a single array<u32> buffer.
 *
 * Buffer layout matches MeshPacking.ts:
 *
 * GLOBAL HEADER (16 u32s):
 *   [0]     numWaveSources
 *   [1..8]  meshOffset[0..7]
 *   [9..15] padding
 *
 * PER-WAVE MESH HEADER (16 u32s):
 *   [+0]  vertexOffset      [+1]  vertexCount
 *   [+2]  indexOffset        [+3]  triangleCount
 *   [+4]  gridOffset         [+5]  gridCols
 *   [+6]  gridRows           [+7]  gridMinX (f32)
 *   [+8]  gridMinY (f32)     [+9]  gridCellSize (f32)
 *   [+10..15] padding
 *
 * All float values are stored as u32 and recovered via bitcast<f32>().
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";

/**
 * Per-wave mesh metadata struct.
 */
export const struct_MeshHeader: ShaderModule = {
  preamble: /*wgsl*/ `
struct MeshHeader {
  vertexOffset: u32,
  vertexCount: u32,
  indexOffset: u32,
  triangleCount: u32,
  gridOffset: u32,
  gridCols: u32,
  gridRows: u32,
  gridMinX: f32,
  gridMinY: f32,
  gridCellSize: f32,
}
`,
  code: "",
};

/**
 * Result of looking up mesh data at a world position.
 */
export const struct_MeshLookupResult: ShaderModule = {
  preamble: /*wgsl*/ `
struct MeshLookupResult {
  amplitudeFactor: f32,
  directionOffset: f32,
  phaseOffset: f32,
  blendWeight: f32,
  found: bool,
}
`,
  code: "",
};

/**
 * Get the number of wave sources from the global header.
 */
export const fn_getMeshNumWaves: ShaderModule = {
  code: /*wgsl*/ `
fn getMeshNumWaves(packed: ptr<storage, array<u32>, read>) -> u32 {
  return (*packed)[0u];
}
`,
};

/**
 * Get the mesh header for a specific wave source.
 */
export const fn_getMeshHeader: ShaderModule = {
  dependencies: [struct_MeshHeader],
  code: /*wgsl*/ `
fn getMeshHeader(packed: ptr<storage, array<u32>, read>, waveIndex: u32) -> MeshHeader {
  let headerOffset = (*packed)[1u + waveIndex];
  var h: MeshHeader;
  h.vertexOffset = (*packed)[headerOffset + 0u];
  h.vertexCount = (*packed)[headerOffset + 1u];
  h.indexOffset = (*packed)[headerOffset + 2u];
  h.triangleCount = (*packed)[headerOffset + 3u];
  h.gridOffset = (*packed)[headerOffset + 4u];
  h.gridCols = (*packed)[headerOffset + 5u];
  h.gridRows = (*packed)[headerOffset + 6u];
  h.gridMinX = bitcast<f32>((*packed)[headerOffset + 7u]);
  h.gridMinY = bitcast<f32>((*packed)[headerOffset + 8u]);
  h.gridCellSize = bitcast<f32>((*packed)[headerOffset + 9u]);
  return h;
}
`,
};

/**
 * Read vertex position from packed buffer.
 * Each vertex is 6 floats: [posX, posY, ampFactor, dirOffset, phaseOffset, blendWeight]
 */
export const fn_getMeshVertexPos: ShaderModule = {
  code: /*wgsl*/ `
fn getMeshVertexPos(packed: ptr<storage, array<u32>, read>, vertexOffset: u32, index: u32) -> vec2<f32> {
  let base = vertexOffset + index * 6u;
  return vec2<f32>(
    bitcast<f32>((*packed)[base]),
    bitcast<f32>((*packed)[base + 1u])
  );
}
`,
};

/**
 * Read vertex attributes (amplitude, direction, phase, blendWeight) from packed buffer.
 */
export const fn_getMeshVertexAttribs: ShaderModule = {
  code: /*wgsl*/ `
fn getMeshVertexAttribs(packed: ptr<storage, array<u32>, read>, vertexOffset: u32, index: u32) -> vec4<f32> {
  let base = vertexOffset + index * 6u;
  return vec4<f32>(
    bitcast<f32>((*packed)[base + 2u]),
    bitcast<f32>((*packed)[base + 3u]),
    bitcast<f32>((*packed)[base + 4u]),
    bitcast<f32>((*packed)[base + 5u])
  );
}
`,
};

/**
 * Read triangle indices from packed buffer.
 */
export const fn_getMeshTriangle: ShaderModule = {
  code: /*wgsl*/ `
fn getMeshTriangle(packed: ptr<storage, array<u32>, read>, indexOffset: u32, triIndex: u32) -> vec3<u32> {
  let base = indexOffset + triIndex * 3u;
  return vec3<u32>(
    (*packed)[base],
    (*packed)[base + 1u],
    (*packed)[base + 2u]
  );
}
`,
};

/**
 * Read grid cell data (triListOffset, triListCount).
 */
export const fn_getMeshGridCell: ShaderModule = {
  code: /*wgsl*/ `
fn getMeshGridCell(packed: ptr<storage, array<u32>, read>, gridOffset: u32, cellIndex: u32) -> vec2<u32> {
  let base = gridOffset + cellIndex * 2u;
  return vec2<u32>(
    (*packed)[base],
    (*packed)[base + 1u]
  );
}
`,
};

/**
 * Read triangle index from grid triangle list.
 */
export const fn_getMeshGridTriIndex: ShaderModule = {
  code: /*wgsl*/ `
fn getMeshGridTriIndex(packed: ptr<storage, array<u32>, read>, listOffset: u32) -> u32 {
  return (*packed)[listOffset];
}
`,
};

/**
 * Compute barycentric coordinates for point p in triangle (a, b, c).
 * Returns vec3(u, v, w) where u + v + w = 1.
 * If any component is negative, the point is outside the triangle.
 */
export const fn_barycentric: ShaderModule = {
  code: /*wgsl*/ `
fn barycentric(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>, c: vec2<f32>) -> vec3<f32> {
  let v0 = b - a;
  let v1 = c - a;
  let v2 = p - a;

  let d00 = dot(v0, v0);
  let d01 = dot(v0, v1);
  let d11 = dot(v1, v1);
  let d20 = dot(v2, v0);
  let d21 = dot(v2, v1);

  let denom = d00 * d11 - d01 * d01;
  if (abs(denom) < 1e-10) {
    return vec3<f32>(-1.0, -1.0, -1.0); // Degenerate triangle
  }

  let invDenom = 1.0 / denom;
  let v = (d11 * d20 - d01 * d21) * invDenom;
  let w = (d00 * d21 - d01 * d20) * invDenom;
  let u = 1.0 - v - w;

  return vec3<f32>(u, v, w);
}
`,
};

/**
 * Look up mesh data for a specific wave at a world position.
 * Uses spatial grid for efficient triangle search, then barycentric interpolation.
 *
 * Returns MeshLookupResult with amplitudeFactor, directionOffset, phaseOffset.
 * If no containing triangle is found, returns defaults (1.0, 0.0, 0.0) = open ocean.
 */
export const fn_lookupMeshForWave: ShaderModule = {
  dependencies: [
    struct_MeshHeader,
    struct_MeshLookupResult,
    fn_getMeshNumWaves,
    fn_getMeshHeader,
    fn_getMeshVertexPos,
    fn_getMeshVertexAttribs,
    fn_getMeshTriangle,
    fn_getMeshGridCell,
    fn_getMeshGridTriIndex,
    fn_barycentric,
  ],
  code: /*wgsl*/ `
fn lookupMeshForWave(
  worldPos: vec2<f32>,
  packed: ptr<storage, array<u32>, read>,
  waveIndex: u32,
) -> MeshLookupResult {
  var result: MeshLookupResult;
  result.amplitudeFactor = 1.0;
  result.directionOffset = 0.0;
  result.phaseOffset = 0.0;
  result.blendWeight = 0.0;
  result.found = false;

  let numWaves = getMeshNumWaves(packed);
  if (waveIndex >= numWaves) {
    return result;
  }

  let header = getMeshHeader(packed, waveIndex);
  if (header.triangleCount == 0u) {
    return result;
  }

  // Map world position to grid cell
  let gx = (worldPos.x - header.gridMinX) / header.gridCellSize;
  let gy = (worldPos.y - header.gridMinY) / header.gridCellSize;

  let col = i32(floor(gx));
  let row = i32(floor(gy));

  // Out of grid bounds → open ocean
  if (col < 0 || col >= i32(header.gridCols) || row < 0 || row >= i32(header.gridRows)) {
    return result;
  }

  let cellIndex = u32(row) * header.gridCols + u32(col);
  let cell = getMeshGridCell(packed, header.gridOffset, cellIndex);
  let triListOffset = cell.x;
  let triListCount = cell.y;

  // Iterate triangles in this cell
  for (var t = 0u; t < triListCount; t++) {
    let triIndex = getMeshGridTriIndex(packed, triListOffset + t);
    let tri = getMeshTriangle(packed, header.indexOffset, triIndex);

    let a = getMeshVertexPos(packed, header.vertexOffset, tri.x);
    let b = getMeshVertexPos(packed, header.vertexOffset, tri.y);
    let c = getMeshVertexPos(packed, header.vertexOffset, tri.z);

    let bary = barycentric(worldPos, a, b, c);

    // Check if point is inside triangle (with small tolerance)
    if (bary.x >= -0.001 && bary.y >= -0.001 && bary.z >= -0.001) {
      let attribA = getMeshVertexAttribs(packed, header.vertexOffset, tri.x);
      let attribB = getMeshVertexAttribs(packed, header.vertexOffset, tri.y);
      let attribC = getMeshVertexAttribs(packed, header.vertexOffset, tri.z);

      // Barycentric interpolation of attributes
      let interp = attribA * bary.x + attribB * bary.y + attribC * bary.z;

      result.amplitudeFactor = interp.x;
      result.directionOffset = interp.y;
      result.phaseOffset = interp.z;
      result.blendWeight = interp.w;
      result.found = true;
      return result;
    }
  }

  return result;
}
`,
};
