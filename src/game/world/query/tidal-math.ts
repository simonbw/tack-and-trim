/**
 * TypeScript port of `fn_lookupTidalFlow` from
 * `src/game/world/shaders/tide-mesh-packed.wgsl.ts`.
 *
 * Walks the packed tide mesh: maps the query point to its grid cell,
 * scans the cell's triangle list for the containing triangle, brackets
 * the two nearest tide levels, interpolates orthogonal flow fields A
 * (cos) and B (sin), and scales by `tidalStrength`.
 *
 * Worker-safe. Writes the output vec2 into a caller-supplied length-2
 * scratch buffer (zero allocations on the hot path).
 */

// Packed-buffer header layout (16 u32s). Mirrors the comment block at
// the top of `tide-mesh-packed.wgsl.ts`.
const HEADER_TIDE_LEVEL_COUNT = 0;
const HEADER_VERTEX_COUNT = 1;
// const HEADER_TRIANGLE_COUNT = 2;   // unused in the lookup
const HEADER_GRID_COLS = 3;
const HEADER_GRID_ROWS = 4;
const HEADER_GRID_MIN_X = 5;
const HEADER_GRID_MIN_Y = 6;
const HEADER_GRID_CELL_WIDTH = 7;
const HEADER_GRID_CELL_HEIGHT = 8;
const HEADER_TIDE_LEVEL_TABLE_OFFSET = 9;
const HEADER_VERTEX_DATA_OFFSET = 10;
const HEADER_FLOW_DATA_OFFSET = 11;
const HEADER_INDEX_DATA_OFFSET = 12;
const HEADER_GRID_CELL_HEADERS_OFFSET = 13;
// const HEADER_GRID_TRIANGLE_LISTS_OFFSET = 14; // unused: cell header carries the list offset

const _bary: Float64Array = new Float64Array(3);

/**
 * Write the tidal flow velocity at (worldX, worldY) into
 * `out[0], out[1]`. Returns without touching `out` when the query point
 * falls outside the mesh (grid bounds or no triangle covers it).
 */
export function lookupTidalFlow(
  worldX: number,
  worldY: number,
  packedTide: Uint32Array,
  tideHeight: number,
  tidalPhase: number,
  tidalStrength: number,
  out: Float64Array,
): void {
  out[0] = 0;
  out[1] = 0;

  if (packedTide.length < 16) return;

  const u32 = packedTide;
  const f32 = new Float32Array(u32.buffer, u32.byteOffset, u32.length);

  const tideLevelCount = u32[HEADER_TIDE_LEVEL_COUNT];
  if (tideLevelCount === 0) return;

  const vertexCount = u32[HEADER_VERTEX_COUNT];
  const gridCols = u32[HEADER_GRID_COLS];
  const gridRows = u32[HEADER_GRID_ROWS];
  const gridMinX = f32[HEADER_GRID_MIN_X];
  const gridMinY = f32[HEADER_GRID_MIN_Y];
  const gridCellWidth = f32[HEADER_GRID_CELL_WIDTH];
  const gridCellHeight = f32[HEADER_GRID_CELL_HEIGHT];
  const tideLevelTableOffset = u32[HEADER_TIDE_LEVEL_TABLE_OFFSET];
  const vertexDataOffset = u32[HEADER_VERTEX_DATA_OFFSET];
  const flowDataOffset = u32[HEADER_FLOW_DATA_OFFSET];
  const indexDataOffset = u32[HEADER_INDEX_DATA_OFFSET];
  const gridCellHeadersOffset = u32[HEADER_GRID_CELL_HEADERS_OFFSET];

  const gx = (worldX - gridMinX) / gridCellWidth;
  const gy = (worldY - gridMinY) / gridCellHeight;
  const col = Math.floor(gx);
  const row = Math.floor(gy);
  if (col < 0 || col >= gridCols || row < 0 || row >= gridRows) return;

  const cellIndex = row * gridCols + col;
  const cellBase = gridCellHeadersOffset + cellIndex * 2;
  const triListOffset = u32[cellBase];
  const triListCount = u32[cellBase + 1];

  for (let t = 0; t < triListCount; t++) {
    const triIndex = u32[triListOffset + t];
    const idxBase = indexDataOffset + triIndex * 3;
    const i0 = u32[idxBase];
    const i1 = u32[idxBase + 1];
    const i2 = u32[idxBase + 2];

    // Vertex positions (2 f32 each)
    const v0Base = vertexDataOffset + i0 * 2;
    const v1Base = vertexDataOffset + i1 * 2;
    const v2Base = vertexDataOffset + i2 * 2;
    const v0x = f32[v0Base];
    const v0y = f32[v0Base + 1];
    const v1x = f32[v1Base];
    const v1y = f32[v1Base + 1];
    const v2x = f32[v2Base];
    const v2y = f32[v2Base + 1];

    barycentric(worldX, worldY, v0x, v0y, v1x, v1y, v2x, v2y);
    if (_bary[0] >= -0.001 && _bary[1] >= -0.001 && _bary[2] >= -0.001) {
      // Bracket tide levels
      let lowerIdx = 0;
      let upperIdx = 0;
      let interpT = 0;

      if (tideLevelCount === 1) {
        // lowerIdx = upperIdx = 0, interpT = 0 already.
      } else {
        const firstLevel = f32[tideLevelTableOffset];
        const lastLevel = f32[tideLevelTableOffset + tideLevelCount - 1];
        if (tideHeight <= firstLevel) {
          // lowerIdx = upperIdx = 0, interpT = 0
        } else if (tideHeight >= lastLevel) {
          lowerIdx = tideLevelCount - 1;
          upperIdx = tideLevelCount - 1;
        } else {
          for (let li = 0; li < tideLevelCount - 1; li++) {
            const levelLow = f32[tideLevelTableOffset + li];
            const levelHigh = f32[tideLevelTableOffset + li + 1];
            if (tideHeight >= levelLow && tideHeight <= levelHigh) {
              lowerIdx = li;
              upperIdx = li + 1;
              const range = levelHigh - levelLow;
              if (Math.abs(range) > 1e-6) {
                interpT = (tideHeight - levelLow) / range;
              }
              break;
            }
          }
        }
      }

      // Per-vertex flow at the lower tide level, weighted by bary
      const lowerBase = flowDataOffset + lowerIdx * vertexCount * 4;
      const fL0 = lowerBase + i0 * 4;
      const fL1 = lowerBase + i1 * 4;
      const fL2 = lowerBase + i2 * 4;
      const flowLowerX =
        f32[fL0] * _bary[0] + f32[fL1] * _bary[1] + f32[fL2] * _bary[2];
      const flowLowerY =
        f32[fL0 + 1] * _bary[0] +
        f32[fL1 + 1] * _bary[1] +
        f32[fL2 + 1] * _bary[2];
      const flowLowerZ =
        f32[fL0 + 2] * _bary[0] +
        f32[fL1 + 2] * _bary[1] +
        f32[fL2 + 2] * _bary[2];
      const flowLowerW =
        f32[fL0 + 3] * _bary[0] +
        f32[fL1 + 3] * _bary[1] +
        f32[fL2 + 3] * _bary[2];

      // Upper tide level
      const upperBase = flowDataOffset + upperIdx * vertexCount * 4;
      const fU0 = upperBase + i0 * 4;
      const fU1 = upperBase + i1 * 4;
      const fU2 = upperBase + i2 * 4;
      const flowUpperX =
        f32[fU0] * _bary[0] + f32[fU1] * _bary[1] + f32[fU2] * _bary[2];
      const flowUpperY =
        f32[fU0 + 1] * _bary[0] +
        f32[fU1 + 1] * _bary[1] +
        f32[fU2 + 1] * _bary[2];
      const flowUpperZ =
        f32[fU0 + 2] * _bary[0] +
        f32[fU1 + 2] * _bary[1] +
        f32[fU2 + 2] * _bary[2];
      const flowUpperW =
        f32[fU0 + 3] * _bary[0] +
        f32[fU1 + 3] * _bary[1] +
        f32[fU2 + 3] * _bary[2];

      // Lerp between tide levels.
      const flowX = flowLowerX + (flowUpperX - flowLowerX) * interpT;
      const flowY = flowLowerY + (flowUpperY - flowLowerY) * interpT;
      const flowZ = flowLowerZ + (flowUpperZ - flowLowerZ) * interpT;
      const flowW = flowLowerW + (flowUpperW - flowLowerW) * interpT;

      // Blend orthogonal fields: A (cos) + B (sin), then scale.
      const cosP = Math.cos(tidalPhase);
      const sinP = Math.sin(tidalPhase);
      out[0] = (flowX * cosP + flowZ * sinP) * tidalStrength;
      out[1] = (flowY * cosP + flowW * sinP) * tidalStrength;
      return;
    }
  }
  // No triangle covered the point — out stays at (0, 0).
}

function barycentric(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): void {
  const v0x = bx - ax;
  const v0y = by - ay;
  const v1x = cx - ax;
  const v1y = cy - ay;
  const v2x = px - ax;
  const v2y = py - ay;

  const d00 = v0x * v0x + v0y * v0y;
  const d01 = v0x * v1x + v0y * v1y;
  const d11 = v1x * v1x + v1y * v1y;
  const d20 = v2x * v0x + v2y * v0y;
  const d21 = v2x * v1x + v2y * v1y;

  const denom = d00 * d11 - d01 * d01;
  if (Math.abs(denom) < 1e-10) {
    _bary[0] = -1;
    _bary[1] = -1;
    _bary[2] = -1;
    return;
  }

  const inv = 1 / denom;
  const v = (d11 * d20 - d01 * d21) * inv;
  const w = (d00 * d21 - d01 * d20) * inv;
  _bary[0] = 1 - v - w;
  _bary[1] = v;
  _bary[2] = w;
}
