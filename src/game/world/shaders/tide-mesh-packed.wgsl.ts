/**
 * Packed tide mesh accessor functions for reading from a single array<u32> buffer.
 *
 * Buffer layout matches TideMeshPacking.ts:
 *
 * HEADER (16 u32s):
 *   [0]  tideLevelCount
 *   [1]  vertexCount
 *   [2]  triangleCount
 *   [3]  gridCols
 *   [4]  gridRows
 *   [5]  gridMinX (f32 as u32)
 *   [6]  gridMinY (f32 as u32)
 *   [7]  gridCellWidth (f32 as u32)
 *   [8]  gridCellHeight (f32 as u32)
 *   [9]  tideLevelTableOffset
 *   [10] vertexDataOffset
 *   [11] flowDataOffset
 *   [12] indexDataOffset
 *   [13] gridCellHeadersOffset
 *   [14] gridTriangleListsOffset
 *   [15] padding
 *
 * DATA SECTIONS:
 *   Tide level table: tideLevelCount f32s (as u32 bitcast)
 *   Vertex positions: vertexCount * 2 f32s (as u32)
 *   Flow data: tideLevelCount * vertexCount * 4 f32s (as u32) — (vx_a, vy_a, vx_b, vy_b)
 *   Index data: triangleCount * 3 u32s
 *   Grid cell headers: gridCols * gridRows * 2 u32s (offset, count)
 *   Grid triangle lists: variable u32s
 *
 * All float values are stored as u32 and recovered via bitcast<f32>().
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";
import { fn_barycentric } from "./mesh-packed.wgsl";

/**
 * Bitcast a u32 from the packed buffer to f32.
 */
export const fn_tideMeshReadF32: ShaderModule = {
  code: /*wgsl*/ `
fn tideMeshReadF32(packed: ptr<storage, array<u32>, read>, index: u32) -> f32 {
  return bitcast<f32>((*packed)[index]);
}
`,
};

/**
 * Read a vertex position from the tide mesh vertex data.
 * Each vertex is 2 f32s: [posX, posY].
 */
export const fn_tideMeshGetVertex: ShaderModule = {
  dependencies: [fn_tideMeshReadF32],
  code: /*wgsl*/ `
fn tideMeshGetVertex(packed: ptr<storage, array<u32>, read>, vertexDataOffset: u32, idx: u32) -> vec2<f32> {
  let base = vertexDataOffset + idx * 2u;
  return vec2<f32>(
    tideMeshReadF32(packed, base),
    tideMeshReadF32(packed, base + 1u)
  );
}
`,
};

/**
 * Read flow data for a vertex at a given tide level.
 * Flow data layout per vertex per tide level: 4 f32s (vx_a, vy_a, vx_b, vy_b).
 * Returns vec4(vx_a, vy_a, vx_b, vy_b).
 */
export const fn_tideMeshGetFlow: ShaderModule = {
  dependencies: [fn_tideMeshReadF32],
  code: /*wgsl*/ `
fn tideMeshGetFlow(
  packed: ptr<storage, array<u32>, read>,
  flowDataOffset: u32,
  vertexCount: u32,
  tideLevelIdx: u32,
  vertexIdx: u32,
) -> vec4<f32> {
  let base = flowDataOffset + (tideLevelIdx * vertexCount + vertexIdx) * 4u;
  return vec4<f32>(
    tideMeshReadF32(packed, base),
    tideMeshReadF32(packed, base + 1u),
    tideMeshReadF32(packed, base + 2u),
    tideMeshReadF32(packed, base + 3u)
  );
}
`,
};

/**
 * Barycentric coordinate computation for tidal flow lookup.
 * Reuses the shared barycentric function from mesh-packed.wgsl.ts.
 */
export const fn_tidalFlowBarycentric: ShaderModule = {
  dependencies: [fn_barycentric],
  code: "",
};

/**
 * Look up tidal flow velocity at a world position.
 *
 * Uses spatial grid for efficient triangle search, then barycentric interpolation
 * across tide levels and orthogonal flow fields.
 *
 * Algorithm:
 * 1. Read header from packed buffer
 * 2. Map world position to grid cell (axis-aligned)
 * 3. Search triangles in grid cell via barycentric containment test
 * 4. Interpolate flow between bracketing tide levels
 * 5. Blend orthogonal flow fields A and B using tidalPhase
 * 6. Scale by tidalStrength
 */
export const fn_lookupTidalFlow: ShaderModule = {
  dependencies: [
    fn_tideMeshReadF32,
    fn_tideMeshGetVertex,
    fn_tideMeshGetFlow,
    fn_barycentric,
  ],
  code: /*wgsl*/ `
fn lookupTidalFlow(
  worldPos: vec2<f32>,
  packedTide: ptr<storage, array<u32>, read>,
  tideHeight: f32,
  tidalPhase: f32,
  tidalStrength: f32,
) -> vec2<f32> {
  // Read header
  let tideLevelCount = (*packedTide)[0u];
  let vertexCount = (*packedTide)[1u];
  let triangleCount = (*packedTide)[2u];
  let gridCols = (*packedTide)[3u];
  let gridRows = (*packedTide)[4u];
  let gridMinX = tideMeshReadF32(packedTide, 5u);
  let gridMinY = tideMeshReadF32(packedTide, 6u);
  let gridCellWidth = tideMeshReadF32(packedTide, 7u);
  let gridCellHeight = tideMeshReadF32(packedTide, 8u);
  let tideLevelTableOffset = (*packedTide)[9u];
  let vertexDataOffset = (*packedTide)[10u];
  let flowDataOffset = (*packedTide)[11u];
  let indexDataOffset = (*packedTide)[12u];
  let gridCellHeadersOffset = (*packedTide)[13u];
  let gridTriangleListsOffset = (*packedTide)[14u];

  if (tideLevelCount == 0u) {
    return vec2<f32>(0.0, 0.0);
  }

  // Map world position to grid cell (axis-aligned, no rotation)
  let gx = (worldPos.x - gridMinX) / gridCellWidth;
  let gy = (worldPos.y - gridMinY) / gridCellHeight;

  let col = i32(floor(gx));
  let row = i32(floor(gy));

  // Bounds check
  if (col < 0 || col >= i32(gridCols) || row < 0 || row >= i32(gridRows)) {
    return vec2<f32>(0.0, 0.0);
  }

  // Read cell header (offset, count)
  let cellIndex = u32(row) * gridCols + u32(col);
  let cellBase = gridCellHeadersOffset + cellIndex * 2u;
  let triListOffset = (*packedTide)[cellBase];
  let triListCount = (*packedTide)[cellBase + 1u];

  // Search triangles in this cell
  for (var t = 0u; t < triListCount; t++) {
    let triIndex = (*packedTide)[triListOffset + t];

    // Read 3 vertex indices
    let idxBase = indexDataOffset + triIndex * 3u;
    let i0 = (*packedTide)[idxBase];
    let i1 = (*packedTide)[idxBase + 1u];
    let i2 = (*packedTide)[idxBase + 2u];

    // Read vertex positions
    let v0 = tideMeshGetVertex(packedTide, vertexDataOffset, i0);
    let v1 = tideMeshGetVertex(packedTide, vertexDataOffset, i1);
    let v2 = tideMeshGetVertex(packedTide, vertexDataOffset, i2);

    // Compute barycentric coordinates
    let bary = barycentric(worldPos, v0, v1, v2);

    // Check if point is inside triangle (with small tolerance)
    if (bary.x >= -0.001 && bary.y >= -0.001 && bary.z >= -0.001) {
      // Find bracketing tide levels
      var lowerIdx = 0u;
      var upperIdx = 0u;
      var interpT = 0.0f;

      if (tideLevelCount == 1u) {
        lowerIdx = 0u;
        upperIdx = 0u;
        interpT = 0.0;
      } else {
        // Read tide levels to find bracket
        let firstLevel = tideMeshReadF32(packedTide, tideLevelTableOffset);
        let lastLevel = tideMeshReadF32(packedTide, tideLevelTableOffset + tideLevelCount - 1u);

        if (tideHeight <= firstLevel) {
          lowerIdx = 0u;
          upperIdx = 0u;
          interpT = 0.0;
        } else if (tideHeight >= lastLevel) {
          lowerIdx = tideLevelCount - 1u;
          upperIdx = tideLevelCount - 1u;
          interpT = 0.0;
        } else {
          // Search for bracket
          for (var li = 0u; li < tideLevelCount - 1u; li++) {
            let levelLow = tideMeshReadF32(packedTide, tideLevelTableOffset + li);
            let levelHigh = tideMeshReadF32(packedTide, tideLevelTableOffset + li + 1u);
            if (tideHeight >= levelLow && tideHeight <= levelHigh) {
              lowerIdx = li;
              upperIdx = li + 1u;
              let range = levelHigh - levelLow;
              if (abs(range) > 1e-6) {
                interpT = (tideHeight - levelLow) / range;
              }
              break;
            }
          }
        }
      }

      // Read and interpolate flow at the lower tide level
      let flowA0 = tideMeshGetFlow(packedTide, flowDataOffset, vertexCount, lowerIdx, i0);
      let flowA1 = tideMeshGetFlow(packedTide, flowDataOffset, vertexCount, lowerIdx, i1);
      let flowA2 = tideMeshGetFlow(packedTide, flowDataOffset, vertexCount, lowerIdx, i2);
      let flowLower = flowA0 * bary.x + flowA1 * bary.y + flowA2 * bary.z;

      // Read and interpolate flow at the upper tide level
      let flowB0 = tideMeshGetFlow(packedTide, flowDataOffset, vertexCount, upperIdx, i0);
      let flowB1 = tideMeshGetFlow(packedTide, flowDataOffset, vertexCount, upperIdx, i1);
      let flowB2 = tideMeshGetFlow(packedTide, flowDataOffset, vertexCount, upperIdx, i2);
      let flowUpper = flowB0 * bary.x + flowB1 * bary.y + flowB2 * bary.z;

      // Lerp between tide levels
      let flow = mix(flowLower, flowUpper, interpT);

      // Blend orthogonal fields: field A (cos) + field B (sin)
      let vx = flow.x * cos(tidalPhase) + flow.z * sin(tidalPhase);
      let vy = flow.y * cos(tidalPhase) + flow.w * sin(tidalPhase);

      return vec2<f32>(vx, vy) * tidalStrength;
    }
  }

  // No containing triangle found
  return vec2<f32>(0.0, 0.0);
}
`,
};
