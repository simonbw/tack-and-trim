/**
 * TypeScript port of wind mesh lookup from
 * `src/game/world/shaders/wind-mesh-packed.wgsl.ts`.
 *
 * Walks the packed wind mesh for each active source, does a spatial-grid
 * triangle lookup, computes barycentric coordinates, and blends source
 * attributes (speedFactor, directionOffset, turbulence) weighted by each
 * source's current activation weight.
 *
 * Worker-safe: no DOM or BaseEntity imports.
 */

import { MAX_WIND_SOURCES } from "../wind/WindConstants";

const GLOBAL_HEADER_MESH_OFFSETS = 1;

// Module-level scratch: barycentric result
const _bary: Float64Array = new Float64Array(3);

// Module-level output slot: [speedFactor, directionOffset, turbulence, found(0|1)]
const _result: Float64Array = new Float64Array(4);

/**
 * Look up mesh-based wind influence at (worldX, worldY) blended across
 * active sources. On return, the out array holds
 *   [speedFactor, directionOffset, turbulence, found]
 * where `found` is 1.0 when any source triangle covered the point,
 * otherwise 0.0. The caller should fall back to the uniform defaults
 * when found === 0.
 */
export function lookupWindMeshBlended(
  worldX: number,
  worldY: number,
  packed: Uint32Array,
  weights: Float32Array,
  out: Float64Array,
): void {
  out[0] = 1.0; // speedFactor default
  out[1] = 0.0; // directionOffset default
  out[2] = 0.0; // turbulence default
  out[3] = 0.0; // found

  const numSources = packed[0];
  if (numSources === 0) return;

  // f32 view over the same backing buffer (shared offset/length).
  const f32 = new Float32Array(packed.buffer, packed.byteOffset, packed.length);

  let totalWeight = 0;
  let accSpeed = 0;
  let accDir = 0;
  let accTurb = 0;
  let anyFound = false;

  const limit = Math.min(numSources, MAX_WIND_SOURCES);
  for (let s = 0; s < limit; s++) {
    const w = weights[s];
    if (w <= 0) continue;

    const meshOffset = packed[GLOBAL_HEADER_MESH_OFFSETS + s];
    lookupWindMeshForSource(worldX, worldY, packed, f32, meshOffset);
    if (_result[3] > 0) {
      accSpeed += _result[0] * w;
      accDir += _result[1] * w;
      accTurb += _result[2] * w;
      totalWeight += w;
      anyFound = true;
    }
  }

  if (anyFound && totalWeight > 0) {
    const inv = 1 / totalWeight;
    out[0] = accSpeed * inv;
    out[1] = accDir * inv;
    out[2] = accTurb * inv;
    out[3] = 1.0;
  }
}

function lookupWindMeshForSource(
  worldX: number,
  worldY: number,
  u32: Uint32Array,
  f32: Float32Array,
  meshOffset: number,
): void {
  _result[0] = 1.0;
  _result[1] = 0.0;
  _result[2] = 0.0;
  _result[3] = 0.0;

  // Mesh header layout (16 u32 with padding; we only read 11):
  //   [0] vertexOffset, [1] vertexCount,
  //   [2] indexOffset, [3] triangleCount,
  //   [4] gridOffset, [5] gridCols, [6] gridRows,
  //   [7] gridMinX (f32), [8] gridMinY (f32),
  //   [9] gridCellWidth (f32), [10] gridCellHeight (f32)
  const vertexOffset = u32[meshOffset + 0];
  const triangleCount = u32[meshOffset + 3];
  if (triangleCount === 0) return;

  const indexOffset = u32[meshOffset + 2];
  const gridOffset = u32[meshOffset + 4];
  const gridCols = u32[meshOffset + 5];
  const gridRows = u32[meshOffset + 6];
  const gridMinX = f32[meshOffset + 7];
  const gridMinY = f32[meshOffset + 8];
  const gridCellWidth = f32[meshOffset + 9];
  const gridCellHeight = f32[meshOffset + 10];

  const gx = (worldX - gridMinX) / gridCellWidth;
  const gy = (worldY - gridMinY) / gridCellHeight;
  const col = Math.floor(gx);
  const row = Math.floor(gy);
  if (col < 0 || col >= gridCols || row < 0 || row >= gridRows) return;

  const cellIndex = row * gridCols + col;
  const cellBase = gridOffset + cellIndex * 2;
  const triListOffset = u32[cellBase];
  const triListCount = u32[cellBase + 1];

  for (let t = 0; t < triListCount; t++) {
    const triIndex = u32[triListOffset + t];
    const triBase = indexOffset + triIndex * 3;
    const ai = u32[triBase];
    const bi = u32[triBase + 1];
    const ci = u32[triBase + 2];

    // Vertex layout: 5 floats per vertex. [0..1] pos, [2..4] attribs.
    const aOff = vertexOffset + ai * 5;
    const bOff = vertexOffset + bi * 5;
    const cOff = vertexOffset + ci * 5;
    const ax = f32[aOff];
    const ay = f32[aOff + 1];
    const bx = f32[bOff];
    const by = f32[bOff + 1];
    const cx = f32[cOff];
    const cy = f32[cOff + 1];

    barycentric(worldX, worldY, ax, ay, bx, by, cx, cy);
    if (_bary[0] >= -0.001 && _bary[1] >= -0.001 && _bary[2] >= -0.001) {
      // Inside (allow small negative tolerance per WGSL)
      const aAttribSpeed = f32[aOff + 2];
      const aAttribDir = f32[aOff + 3];
      const aAttribTurb = f32[aOff + 4];
      const bAttribSpeed = f32[bOff + 2];
      const bAttribDir = f32[bOff + 3];
      const bAttribTurb = f32[bOff + 4];
      const cAttribSpeed = f32[cOff + 2];
      const cAttribDir = f32[cOff + 3];
      const cAttribTurb = f32[cOff + 4];

      _result[0] =
        aAttribSpeed * _bary[0] +
        bAttribSpeed * _bary[1] +
        cAttribSpeed * _bary[2];
      _result[1] =
        aAttribDir * _bary[0] + bAttribDir * _bary[1] + cAttribDir * _bary[2];
      _result[2] =
        aAttribTurb * _bary[0] +
        bAttribTurb * _bary[1] +
        cAttribTurb * _bary[2];
      _result[3] = 1.0;
      return;
    }
  }
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
