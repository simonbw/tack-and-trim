/**
 * CPU-side mesh packing for wavefront mesh query lookup.
 *
 * Packs vertex/index data and a spatial grid index into a single array<u32>
 * buffer for GPU compute shader access. The spatial grid enables efficient
 * triangle lookup via barycentric interpolation.
 *
 * Buffer layout:
 * GLOBAL HEADER (16 u32s):
 *   [0]     numWaveSources
 *   [1..8]  meshOffset[0..7] (absolute u32 offset to each wave's mesh header)
 *   [9..15] padding
 *
 * PER-WAVE MESH HEADER (16 u32s each):
 *   [+0]  vertexOffset      [+1]  vertexCount
 *   [+2]  indexOffset        [+3]  triangleCount
 *   [+4]  gridOffset         [+5]  gridCols
 *   [+6]  gridRows           [+7]  gridMinX (f32)
 *   [+8]  gridMinY (f32)     [+9]  gridCellSize (f32)
 *   [+10..15] padding
 *
 * VERTEX DATA (6 f32-as-u32 per vertex, all sources concatenated)
 * INDEX DATA (3 u32 per triangle, all sources concatenated)
 * GRID CELL HEADERS (2 u32 per cell: triListOffset, triListCount)
 * GRID TRIANGLE LISTS (u32 triangle indices, variable length per cell)
 */

import { getWebGPU } from "../../core/graphics/webgpu/WebGPUDevice";
import { MAX_WAVE_SOURCES } from "./WavePhysicsManager";
import { VERTEX_FLOATS } from "./WavefrontMesh";
import type { WavefrontMesh } from "./WavefrontMesh";

const GLOBAL_HEADER_U32S = 16;
const MESH_HEADER_U32S = 16;
const GRID_DIM = 64;

/** Float bits → u32 for buffer packing */
const f32Buf = new Float32Array(1);
const u32Buf = new Uint32Array(f32Buf.buffer);
function floatToU32(f: number): number {
  f32Buf[0] = f;
  return u32Buf[0];
}

interface MeshGridData {
  /** Per-cell triangle lists */
  cells: Uint32Array[];
  /** Grid dimensions */
  cols: number;
  rows: number;
  /** Grid AABB */
  minX: number;
  minY: number;
  /** Cell size in world units */
  cellSize: number;
}

/**
 * Build a spatial grid index for a single mesh.
 */
function buildSpatialGrid(mesh: WavefrontMesh): MeshGridData {
  const verts = mesh.cpuVertexData;
  const indices = mesh.cpuIndexData;
  const triCount = mesh.indexCount / 3;

  // Compute AABB from vertices
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (let v = 0; v < mesh.vertexCount; v++) {
    const x = verts[v * VERTEX_FLOATS];
    const y = verts[v * VERTEX_FLOATS + 1];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  // Add margin
  const margin = 10;
  minX -= margin;
  minY -= margin;
  maxX += margin;
  maxY += margin;

  const width = maxX - minX;
  const height = maxY - minY;
  const cellSize = Math.max(width, height) / GRID_DIM;
  const cols = Math.ceil(width / cellSize) || 1;
  const rows = Math.ceil(height / cellSize) || 1;

  // Build cell → triangle mappings
  const cellTriLists: number[][] = [];
  for (let i = 0; i < cols * rows; i++) {
    cellTriLists.push([]);
  }

  for (let t = 0; t < triCount; t++) {
    const i0 = indices[t * 3];
    const i1 = indices[t * 3 + 1];
    const i2 = indices[t * 3 + 2];

    const x0 = verts[i0 * VERTEX_FLOATS];
    const y0 = verts[i0 * VERTEX_FLOATS + 1];
    const x1 = verts[i1 * VERTEX_FLOATS];
    const y1 = verts[i1 * VERTEX_FLOATS + 1];
    const x2 = verts[i2 * VERTEX_FLOATS];
    const y2 = verts[i2 * VERTEX_FLOATS + 1];

    // Triangle AABB
    const tMinX = Math.min(x0, x1, x2);
    const tMinY = Math.min(y0, y1, y2);
    const tMaxX = Math.max(x0, x1, x2);
    const tMaxY = Math.max(y0, y1, y2);

    // Grid cell range
    const c0 = Math.max(0, Math.floor((tMinX - minX) / cellSize));
    const c1 = Math.min(cols - 1, Math.floor((tMaxX - minX) / cellSize));
    const r0 = Math.max(0, Math.floor((tMinY - minY) / cellSize));
    const r1 = Math.min(rows - 1, Math.floor((tMaxY - minY) / cellSize));

    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        cellTriLists[r * cols + c].push(t);
      }
    }
  }

  // Convert to Uint32Arrays
  const cells = cellTriLists.map((list) => new Uint32Array(list));

  return { cells, cols, rows, minX, minY, cellSize };
}

/**
 * Build a packed mesh GPU buffer from wavefront meshes.
 * Returns null if no meshes are provided.
 */
export function buildPackedMeshBuffer(
  meshes: readonly WavefrontMesh[],
): GPUBuffer {
  const device = getWebGPU().device;
  const numWaves = Math.min(meshes.length, MAX_WAVE_SOURCES);

  // Build spatial grids for each mesh
  const grids: MeshGridData[] = [];
  for (let i = 0; i < numWaves; i++) {
    grids.push(buildSpatialGrid(meshes[i]));
  }

  // Calculate total buffer size
  let totalU32s = GLOBAL_HEADER_U32S;
  totalU32s += numWaves * MESH_HEADER_U32S;

  // Vertex data
  let totalVertexU32s = 0;
  for (let i = 0; i < numWaves; i++) {
    totalVertexU32s += meshes[i].vertexCount * VERTEX_FLOATS;
  }
  totalU32s += totalVertexU32s;

  // Index data
  let totalIndexU32s = 0;
  for (let i = 0; i < numWaves; i++) {
    totalIndexU32s += meshes[i].indexCount;
  }
  totalU32s += totalIndexU32s;

  // Grid cell headers + triangle lists
  let totalGridHeaderU32s = 0;
  let totalGridListU32s = 0;
  for (const grid of grids) {
    totalGridHeaderU32s += grid.cols * grid.rows * 2;
    for (const cell of grid.cells) {
      totalGridListU32s += cell.length;
    }
  }
  totalU32s += totalGridHeaderU32s + totalGridListU32s;

  // Allocate buffer
  const data = new ArrayBuffer(totalU32s * 4);
  const u32View = new Uint32Array(data);
  const f32View = new Float32Array(data);

  // Write global header
  u32View[0] = numWaves;

  // Calculate offsets
  const headersStart = GLOBAL_HEADER_U32S;
  let vertexStart = headersStart + numWaves * MESH_HEADER_U32S;
  let indexStart = vertexStart + totalVertexU32s;
  let gridHeaderStart = indexStart + totalIndexU32s;
  let gridListStart = gridHeaderStart + totalGridHeaderU32s;

  let currentVertexOffset = vertexStart;
  let currentIndexOffset = indexStart;
  let currentGridHeaderOffset = gridHeaderStart;
  let currentGridListOffset = gridListStart;

  for (let w = 0; w < numWaves; w++) {
    const mesh = meshes[w];
    const grid = grids[w];
    const headerOffset = headersStart + w * MESH_HEADER_U32S;

    // Write mesh offset to global header
    u32View[1 + w] = headerOffset;

    // Write per-wave mesh header
    u32View[headerOffset + 0] = currentVertexOffset;
    u32View[headerOffset + 1] = mesh.vertexCount;
    u32View[headerOffset + 2] = currentIndexOffset;
    u32View[headerOffset + 3] = mesh.indexCount / 3;
    u32View[headerOffset + 4] = currentGridHeaderOffset;
    u32View[headerOffset + 5] = grid.cols;
    u32View[headerOffset + 6] = grid.rows;
    u32View[headerOffset + 7] = floatToU32(grid.minX);
    u32View[headerOffset + 8] = floatToU32(grid.minY);
    u32View[headerOffset + 9] = floatToU32(grid.cellSize);

    // Write vertex data (6 floats per vertex, stored as u32 via shared buffer)
    for (let v = 0; v < mesh.vertexCount * VERTEX_FLOATS; v++) {
      f32View[currentVertexOffset + v] = mesh.cpuVertexData[v];
    }
    currentVertexOffset += mesh.vertexCount * VERTEX_FLOATS;

    // Write index data
    for (let idx = 0; idx < mesh.indexCount; idx++) {
      u32View[currentIndexOffset + idx] = mesh.cpuIndexData[idx];
    }
    currentIndexOffset += mesh.indexCount;

    // Write grid cell headers and triangle lists
    const numCells = grid.cols * grid.rows;
    for (let c = 0; c < numCells; c++) {
      const cell = grid.cells[c];
      u32View[currentGridHeaderOffset + c * 2] = currentGridListOffset;
      u32View[currentGridHeaderOffset + c * 2 + 1] = cell.length;

      for (let t = 0; t < cell.length; t++) {
        u32View[currentGridListOffset + t] = cell[t];
      }
      currentGridListOffset += cell.length;
    }
    currentGridHeaderOffset += numCells * 2;
  }

  // Pad remaining global header slots
  for (let i = numWaves; i < MAX_WAVE_SOURCES; i++) {
    u32View[1 + i] = 0;
  }

  // Create GPU buffer
  const buffer = device.createBuffer({
    size: Math.max(data.byteLength, 64), // min 64 bytes
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    label: "Packed Wavefront Mesh Buffer",
  });
  device.queue.writeBuffer(buffer, 0, data);

  return buffer;
}

/**
 * Create a placeholder packed mesh buffer with numWaveSources = 0.
 */
export function createPlaceholderPackedMeshBuffer(): GPUBuffer {
  const device = getWebGPU().device;
  const buffer = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    label: "Placeholder Packed Mesh Buffer",
  });
  const data = new Uint32Array(GLOBAL_HEADER_U32S);
  data[0] = 0; // numWaveSources = 0
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}
