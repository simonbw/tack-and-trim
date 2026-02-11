/**
 * Grid Eulerian wavefront mesh builder.
 *
 * Solves the eikonal equation on a regular grid via the Fast Marching Method (FMM)
 * to compute wave travel times, then derives direction, phase, and amplitude from
 * the travel time field. Includes diffraction correction in shadow zones.
 * Applies quadtree simplification to reduce vertex count while preserving accuracy.
 *
 * No engine imports -- safe for use in web workers.
 */

import type { WaveSource } from "../../../world/water/WaveSource";
import type {
  MeshBuildBounds,
  TerrainDataForWorker,
  WavefrontMeshData,
} from "../MeshBuildTypes";
import { computeTerrainHeight } from "../../cpu/terrainHeight";
import {
  computeWaveSpeed,
  computeWaveTerrainFactor,
} from "../../cpu/wavePhysics";

// =============================================================================
// Constants
// =============================================================================

const VERTEX_FLOATS = 6;
const GRID_SPACING = 25; // feet
const DEFAULT_DOMAIN_SIZE = 2000; // feet, half-extent when no coastline bounds
const TWO_PI = 2 * Math.PI;

/** FMM cell status */
const FAR = 0;
const TRIAL = 1;
const KNOWN = 2;
const LAND = 3;

/** Quadtree simplification error threshold */
const SIMPLIFY_THRESHOLD = 0.02;

/** Maximum quadtree cell level (2^MAX_LEVEL cells per side at coarsest) */
const MAX_LEVEL = 5; // 2^5 = 32 cells = 800ft at 25ft spacing

// =============================================================================
// Min-Heap for FMM
// =============================================================================

class MinHeap {
  private heap: number[] = []; // grid indices
  private positions: Int32Array; // heap position of each grid index (-1 if not in heap)
  private times: Float32Array; // reference to the grid travel times

  constructor(gridSize: number, times: Float32Array) {
    this.positions = new Int32Array(gridSize).fill(-1);
    this.times = times;
  }

  get size(): number {
    return this.heap.length;
  }

  push(index: number): void {
    this.heap.push(index);
    this.positions[index] = this.heap.length - 1;
    this.bubbleUp(this.heap.length - 1);
  }

  pop(): number {
    const top = this.heap[0];
    const last = this.heap.pop()!;
    this.positions[top] = -1;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.positions[last] = 0;
      this.sinkDown(0);
    }
    return top;
  }

  decreaseKey(index: number): void {
    const pos = this.positions[index];
    if (pos >= 0) {
      this.bubbleUp(pos);
    }
  }

  private bubbleUp(pos: number): void {
    const heap = this.heap;
    const positions = this.positions;
    const times = this.times;
    while (pos > 0) {
      const parent = (pos - 1) >> 1;
      if (times[heap[pos]] < times[heap[parent]]) {
        // swap
        const tmp = heap[pos];
        heap[pos] = heap[parent];
        heap[parent] = tmp;
        positions[heap[pos]] = pos;
        positions[heap[parent]] = parent;
        pos = parent;
      } else {
        break;
      }
    }
  }

  private sinkDown(pos: number): void {
    const heap = this.heap;
    const positions = this.positions;
    const times = this.times;
    const len = heap.length;
    while (true) {
      let smallest = pos;
      const left = 2 * pos + 1;
      const right = 2 * pos + 2;
      if (left < len && times[heap[left]] < times[heap[smallest]]) {
        smallest = left;
      }
      if (right < len && times[heap[right]] < times[heap[smallest]]) {
        smallest = right;
      }
      if (smallest !== pos) {
        const tmp = heap[pos];
        heap[pos] = heap[smallest];
        heap[smallest] = tmp;
        positions[heap[pos]] = pos;
        positions[heap[smallest]] = smallest;
        pos = smallest;
      } else {
        break;
      }
    }
  }
}

// =============================================================================
// Main Builder
// =============================================================================

export function buildGridEulerianMesh(
  waveSource: WaveSource,
  coastlineBounds: MeshBuildBounds | null,
  terrain: TerrainDataForWorker,
  tideHeight: number,
): WavefrontMeshData {
  const wavelength = waveSource.wavelength;
  const waveDir = waveSource.direction;
  const period = wavelength / computeWaveSpeed(wavelength, 1000); // deep water speed -> period
  const omega = TWO_PI / period;
  const k = TWO_PI / wavelength;
  const cDeep = computeWaveSpeed(wavelength, 1000);
  const waveDirX = Math.cos(waveDir);
  const waveDirY = Math.sin(waveDir);

  // =========================================================================
  // Phase 1: Grid Setup
  // =========================================================================
  let minX: number, maxX: number, minY: number, maxY: number;
  if (coastlineBounds) {
    // Expand domain well beyond coastline bounds so the mesh covers the full
    // play area.  Terrain affects waves via shoaling at depth < wavelength/2,
    // and we need a smooth transition to open-ocean defaults at the boundary.
    const margin = Math.max(DEFAULT_DOMAIN_SIZE, wavelength * 3);
    minX = coastlineBounds.minX - margin;
    maxX = coastlineBounds.maxX + margin;
    minY = coastlineBounds.minY - margin;
    maxY = coastlineBounds.maxY + margin;
  } else {
    minX = -DEFAULT_DOMAIN_SIZE;
    maxX = DEFAULT_DOMAIN_SIZE;
    minY = -DEFAULT_DOMAIN_SIZE;
    maxY = DEFAULT_DOMAIN_SIZE;
  }

  const cols = Math.max(2, Math.ceil((maxX - minX) / GRID_SPACING) + 1);
  const rows = Math.max(2, Math.ceil((maxY - minY) / GRID_SPACING) + 1);
  const gridSize = cols * rows;

  // Grid data arrays
  const travelTime = new Float32Array(gridSize).fill(Infinity);
  const status = new Uint8Array(gridSize).fill(FAR);
  const speed = new Float32Array(gridSize);
  const depth = new Float32Array(gridSize);
  const diffAmplitude = new Float32Array(gridSize).fill(1.0); // diffraction amplitude multiplier

  // Evaluate terrain at each grid point
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      const px = minX + col * GRID_SPACING;
      const py = minY + row * GRID_SPACING;
      const terrainH = computeTerrainHeight(px, py, terrain);
      const d = tideHeight - terrainH;
      depth[idx] = d;
      if (d <= 0) {
        status[idx] = LAND;
        speed[idx] = 0;
        travelTime[idx] = Infinity;
      } else {
        speed[idx] = computeWaveSpeed(wavelength, d);
      }
    }
  }

  // =========================================================================
  // Phase 2: FMM Phase Solve
  // =========================================================================
  const heap = new MinHeap(gridSize, travelTime);

  // Initialize upwind boundary: points on the domain edge facing the wave.
  // For each grid point, compute initial travel time from the planar wave.
  // Points on the upwind boundary are where waves enter the domain.
  // We seed all water points with their planar travel time and let FMM propagate.
  //
  // For a planar wave, the travel time at position p is:
  //   T = dot(p - origin, waveDir) / cDeep
  // We offset so the minimum T in the domain is 0.

  // Find the minimum planar travel time among water points
  let minT = Infinity;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      if (status[idx] === LAND) continue;
      const px = minX + col * GRID_SPACING;
      const py = minY + row * GRID_SPACING;
      const t = (px * waveDirX + py * waveDirY) / cDeep;
      if (t < minT) minT = t;
    }
  }

  // Seed all upwind grid points: every water point whose planar travel time
  // is within one wavelength of the minimum. This creates a full band of
  // KNOWN points perpendicular to the wave direction, properly initializing
  // a planar wavefront. No edge restriction -- interior points are included
  // so diagonal wave directions don't degenerate into a point source.
  const upwindThreshold = wavelength / cDeep; // one wavelength of travel time
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      if (status[idx] === LAND) continue;

      const px = minX + col * GRID_SPACING;
      const py = minY + row * GRID_SPACING;
      const t = (px * waveDirX + py * waveDirY) / cDeep - minT;

      if (t <= upwindThreshold) {
        travelTime[idx] = Math.max(0, t);
        status[idx] = KNOWN;
      }
    }
  }

  // Add all neighbors of KNOWN points as TRIAL
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      if (status[idx] !== KNOWN) continue;

      const neighbors = getNeighbors(idx, cols, rows);
      for (let n = 0; n < neighbors.length; n++) {
        const ni = neighbors[n];
        if (status[ni] === FAR) {
          const tentT = eikonalUpdate(
            ni,
            cols,
            rows,
            travelTime,
            speed,
            status,
          );
          if (tentT < travelTime[ni]) {
            travelTime[ni] = tentT;
          }
          status[ni] = TRIAL;
          heap.push(ni);
        }
      }
    }
  }

  // FMM main loop
  while (heap.size > 0) {
    const current = heap.pop();
    status[current] = KNOWN;

    const neighbors = getNeighbors(current, cols, rows);
    for (let n = 0; n < neighbors.length; n++) {
      const ni = neighbors[n];
      if (status[ni] === KNOWN || status[ni] === LAND) continue;

      const tentT = eikonalUpdate(ni, cols, rows, travelTime, speed, status);
      if (tentT < travelTime[ni]) {
        travelTime[ni] = tentT;
        if (status[ni] === TRIAL) {
          heap.decreaseKey(ni);
        } else {
          status[ni] = TRIAL;
          heap.push(ni);
        }
      }
    }
  }

  // =========================================================================
  // Phase 3: Diffraction Pass
  // =========================================================================
  // Find shadow boundary points: KNOWN points adjacent to FAR non-land points
  const diffHeap = new MinHeap(gridSize, travelTime);
  const shadowStatus = new Uint8Array(gridSize); // reuse FAR/TRIAL/KNOWN constants
  // Copy status: KNOWN stays KNOWN, LAND stays as a barrier, FAR stays FAR
  for (let i = 0; i < gridSize; i++) {
    if (status[i] === KNOWN) {
      shadowStatus[i] = KNOWN;
    } else if (status[i] === LAND) {
      shadowStatus[i] = LAND;
    }
    // else FAR (default 0)
  }

  // Find shadow boundary points and seed them
  let hasShadow = false;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      if (status[idx] !== KNOWN) continue;

      const neighbors = getNeighbors(idx, cols, rows);
      let adjacentToShadow = false;
      for (let n = 0; n < neighbors.length; n++) {
        if (status[neighbors[n]] === FAR) {
          adjacentToShadow = true;
          break;
        }
      }

      if (adjacentToShadow) {
        // This point becomes a secondary source for diffraction
        // Its travel time is already set from the direct wave
        // We don't push it into the heap -- we push its FAR neighbors
        const neighbors2 = getNeighbors(idx, cols, rows);
        for (let n = 0; n < neighbors2.length; n++) {
          const ni = neighbors2[n];
          if (shadowStatus[ni] !== FAR) continue;

          const tentT = eikonalUpdate(
            ni,
            cols,
            rows,
            travelTime,
            speed,
            shadowStatus,
          );
          if (tentT < travelTime[ni]) {
            travelTime[ni] = tentT;
          }
          shadowStatus[ni] = TRIAL;
          diffHeap.push(ni);
          hasShadow = true;
        }
      }
    }
  }

  // Run second FMM in shadow zone
  if (hasShadow) {
    while (diffHeap.size > 0) {
      const current = diffHeap.pop();
      shadowStatus[current] = KNOWN;

      // Compute diffraction amplitude: cylindrical decay from shadow boundary
      // Distance from nearest shadow boundary point approximated by:
      // T_current - T_nearest_known_neighbor
      // For simplicity, use the travel time difference as a proxy for distance
      const r = Math.max(
        (travelTime[current] -
          getMinKnownNeighborTime(current, cols, rows, travelTime, status)) *
          speed[current],
        GRID_SPACING,
      );
      diffAmplitude[current] = Math.min(
        1.0,
        Math.sqrt(wavelength / (TWO_PI * r)),
      );

      const neighbors = getNeighbors(current, cols, rows);
      for (let n = 0; n < neighbors.length; n++) {
        const ni = neighbors[n];
        if (shadowStatus[ni] === KNOWN || shadowStatus[ni] === LAND) continue;

        const tentT = eikonalUpdate(
          ni,
          cols,
          rows,
          travelTime,
          speed,
          shadowStatus,
        );
        if (tentT < travelTime[ni]) {
          travelTime[ni] = tentT;
          if (shadowStatus[ni] === TRIAL) {
            diffHeap.decreaseKey(ni);
          } else {
            shadowStatus[ni] = TRIAL;
            diffHeap.push(ni);
          }
        }
      }
    }
  }

  // =========================================================================
  // Phase 4: Derive Wave Properties
  // =========================================================================
  const amplitudeFactor = new Float32Array(gridSize);
  const directionOffset = new Float32Array(gridSize);
  const phaseOffset = new Float32Array(gridSize);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;

      // Land or unreachable points
      if (
        status[idx] === LAND ||
        (status[idx] !== KNOWN && shadowStatus[idx] !== KNOWN)
      ) {
        amplitudeFactor[idx] = 0;
        directionOffset[idx] = 0;
        phaseOffset[idx] = 0;
        continue;
      }

      const px = minX + col * GRID_SPACING;
      const py = minY + row * GRID_SPACING;
      const T = travelTime[idx];

      if (!isFinite(T)) {
        amplitudeFactor[idx] = 0;
        directionOffset[idx] = 0;
        phaseOffset[idx] = 0;
        continue;
      }

      // Direction from gradient of travel time
      // The gradient of T points from low T (source) to high T (destination),
      // i.e. the direction the wave is traveling.
      const dTdx = centralDiffX(idx, col, cols, rows, travelTime);
      const dTdy = centralDiffY(idx, row, cols, rows, travelTime);
      const direction = Math.atan2(dTdy, dTdx);
      directionOffset[idx] = normalizeAngle(direction - waveDir);

      // Phase offset: omega * T - dot(position, waveDir * k)
      const planarPhase = (px * waveDirX + py * waveDirY) * k;
      phaseOffset[idx] = normalizeAngle(omega * T - planarPhase);

      // Amplitude factor: terrain factor * convergence factor * diffraction
      const terrainFactor = computeWaveTerrainFactor(depth[idx], wavelength);

      // Convergence from Laplacian of T
      const laplacianT = laplacian(idx, col, row, cols, rows, travelTime);
      const divergence = laplacianT * speed[idx];
      const convergenceFactor = Math.sqrt(
        k / Math.max(Math.abs(divergence * speed[idx]), k * 0.01),
      );
      const clampedConvergence = Math.max(
        0.1,
        Math.min(2.0, convergenceFactor),
      );

      // If this point was in the shadow zone (original status was FAR), apply diffraction decay
      const isDiffracted = status[idx] !== KNOWN;
      const diffMult = isDiffracted ? diffAmplitude[idx] : 1.0;

      amplitudeFactor[idx] = terrainFactor * clampedConvergence * diffMult;
    }
  }

  // =========================================================================
  // Phase 5: Quadtree Simplification
  // =========================================================================
  return buildSimplifiedMesh(
    cols,
    rows,
    minX,
    minY,
    amplitudeFactor,
    directionOffset,
    phaseOffset,
  );
}

// =============================================================================
// FMM Helpers
// =============================================================================

function getNeighbors(idx: number, cols: number, rows: number): number[] {
  const col = idx % cols;
  const row = (idx - col) / cols;
  const result: number[] = [];
  if (col > 0) result.push(idx - 1);
  if (col < cols - 1) result.push(idx + 1);
  if (row > 0) result.push(idx - cols);
  if (row < rows - 1) result.push(idx + cols);
  return result;
}

/**
 * Eikonal update stencil for a grid point.
 * Uses the smallest known neighbor value in each axis direction.
 */
function eikonalUpdate(
  idx: number,
  cols: number,
  rows: number,
  travelTime: Float32Array,
  speed: Float32Array,
  cellStatus: Uint8Array,
): number {
  const col = idx % cols;
  const row = (idx - col) / cols;
  const h = GRID_SPACING;
  const c = speed[idx];
  if (c <= 0) return Infinity;
  const slowness = 1 / c;

  // Find smallest known neighbor in X direction
  let txMin = Infinity;
  if (col > 0 && cellStatus[idx - 1] === KNOWN) {
    txMin = Math.min(txMin, travelTime[idx - 1]);
  }
  if (col < cols - 1 && cellStatus[idx + 1] === KNOWN) {
    txMin = Math.min(txMin, travelTime[idx + 1]);
  }

  // Find smallest known neighbor in Y direction
  let tyMin = Infinity;
  if (row > 0 && cellStatus[idx - cols] === KNOWN) {
    tyMin = Math.min(tyMin, travelTime[idx - cols]);
  }
  if (row < rows - 1 && cellStatus[idx + cols] === KNOWN) {
    tyMin = Math.min(tyMin, travelTime[idx + cols]);
  }

  const hSlow = h * slowness;

  if (!isFinite(txMin) && !isFinite(tyMin)) {
    return Infinity;
  }

  if (!isFinite(txMin)) {
    return tyMin + hSlow;
  }
  if (!isFinite(tyMin)) {
    return txMin + hSlow;
  }

  // Solve quadratic: (T - txMin)^2 + (T - tyMin)^2 = (h * slowness)^2
  const a = 2;
  const b = -2 * (txMin + tyMin);
  const cCoeff = txMin * txMin + tyMin * tyMin - hSlow * hSlow;
  const discriminant = b * b - 4 * a * cCoeff;

  if (discriminant < 0) {
    // Fall back to 1D update from the smaller value
    return Math.min(txMin, tyMin) + hSlow;
  }

  const T = (-b + Math.sqrt(discriminant)) / (2 * a);
  // Verify T >= max(txMin, tyMin)
  if (T >= Math.max(txMin, tyMin)) {
    return T;
  }
  return Math.min(txMin, tyMin) + hSlow;
}

/**
 * Get minimum travel time from neighbors that were KNOWN in the original (non-diffraction) pass.
 */
function getMinKnownNeighborTime(
  idx: number,
  cols: number,
  rows: number,
  travelTime: Float32Array,
  originalStatus: Uint8Array,
): number {
  const col = idx % cols;
  const row = (idx - col) / cols;
  let minT = Infinity;

  if (col > 0 && originalStatus[idx - 1] === KNOWN)
    minT = Math.min(minT, travelTime[idx - 1]);
  if (col < cols - 1 && originalStatus[idx + 1] === KNOWN)
    minT = Math.min(minT, travelTime[idx + 1]);
  if (row > 0 && originalStatus[idx - cols] === KNOWN)
    minT = Math.min(minT, travelTime[idx - cols]);
  if (row < rows - 1 && originalStatus[idx + cols] === KNOWN)
    minT = Math.min(minT, travelTime[idx + cols]);

  return minT;
}

// =============================================================================
// Finite difference helpers
// =============================================================================

function centralDiffX(
  idx: number,
  col: number,
  cols: number,
  _rows: number,
  field: Float32Array,
): number {
  const h = GRID_SPACING;
  if (col > 0 && col < cols - 1) {
    const left = field[idx - 1];
    const right = field[idx + 1];
    if (isFinite(left) && isFinite(right)) return (right - left) / (2 * h);
    if (isFinite(right)) return (right - field[idx]) / h;
    if (isFinite(left)) return (field[idx] - left) / h;
  } else if (col === 0) {
    const right = field[idx + 1];
    if (isFinite(right) && isFinite(field[idx]))
      return (right - field[idx]) / h;
  } else {
    const left = field[idx - 1];
    if (isFinite(left) && isFinite(field[idx])) return (field[idx] - left) / h;
  }
  return 0;
}

function centralDiffY(
  idx: number,
  row: number,
  cols: number,
  rows: number,
  field: Float32Array,
): number {
  const h = GRID_SPACING;
  if (row > 0 && row < rows - 1) {
    const up = field[idx - cols];
    const down = field[idx + cols];
    if (isFinite(up) && isFinite(down)) return (down - up) / (2 * h);
    if (isFinite(down)) return (down - field[idx]) / h;
    if (isFinite(up)) return (field[idx] - up) / h;
  } else if (row === 0) {
    const down = field[idx + cols];
    if (isFinite(down) && isFinite(field[idx])) return (down - field[idx]) / h;
  } else {
    const up = field[idx - cols];
    if (isFinite(up) && isFinite(field[idx])) return (field[idx] - up) / h;
  }
  return 0;
}

function laplacian(
  idx: number,
  col: number,
  row: number,
  cols: number,
  rows: number,
  field: Float32Array,
): number {
  const h = GRID_SPACING;
  const center = field[idx];
  if (!isFinite(center)) return 0;

  let laplX = 0;
  let laplY = 0;

  // d^2/dx^2
  if (col > 0 && col < cols - 1) {
    const left = field[idx - 1];
    const right = field[idx + 1];
    if (isFinite(left) && isFinite(right)) {
      laplX = (left - 2 * center + right) / (h * h);
    }
  }

  // d^2/dy^2
  if (row > 0 && row < rows - 1) {
    const up = field[idx - cols];
    const down = field[idx + cols];
    if (isFinite(up) && isFinite(down)) {
      laplY = (up - 2 * center + down) / (h * h);
    }
  }

  return laplX + laplY;
}

/** Normalize angle to [-PI, PI] */
function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= TWO_PI;
  while (a < -Math.PI) a += TWO_PI;
  return a;
}

// =============================================================================
// Quadtree Simplification + Triangulation
// =============================================================================

interface QuadCell {
  /** Grid column of the top-left corner */
  col: number;
  /** Grid row of the top-left corner */
  row: number;
  /** Cell size in grid cells (always a power of 2) */
  size: number;
  /** Quadtree level (0 = leaf = 1x1 grid cell) */
  level: number;
}

/**
 * Build the simplified mesh using quadtree collapse and triangulation.
 */
function buildSimplifiedMesh(
  cols: number,
  rows: number,
  minX: number,
  minY: number,
  amplitudeFactor: Float32Array,
  directionOffset: Float32Array,
  phaseOffset: Float32Array,
): WavefrontMeshData {
  // Build cells bottom-up: start with smallest cells that can be merged
  // We work with cells whose corners are grid points.
  // A level-L cell spans 2^L grid cells in each direction.

  // Start with level-1 cells (2x2 grid cells, covers 3x3 grid points)
  // and try to merge up.

  // First, compute error for each possible cell at each level.
  // A cell at level L at grid position (col, row) spans from
  // (col, row) to (col + 2^L, row + 2^L) in grid coordinates.

  // Use a grid of cell levels. Initialize all cells at level 0 (finest).
  // Then merge bottom-up.

  // The simplest approach: use a flat array marking which level each
  // "base cell" belongs to.
  // Base cells are at level 0 (1x1 grid spacing).
  // We record the assigned level for each base cell.
  const cellLevel = new Uint8Array((cols - 1) * (rows - 1)).fill(0);

  // Try merging bottom-up
  for (let level = 1; level <= MAX_LEVEL; level++) {
    const cellSize = 1 << level;
    // Iterate over potential parent cells
    for (let row = 0; row + cellSize < rows; row += cellSize) {
      for (let col = 0; col + cellSize < cols; col += cellSize) {
        // Check if all child cells at level-1 are at that level
        const childSize = cellSize >> 1;
        let canMerge = true;

        // Check that all 4 children exist and are at level-1
        for (let cr = 0; cr < 2 && canMerge; cr++) {
          for (let cc = 0; cc < 2 && canMerge; cc++) {
            const childRow = row + cr * childSize;
            const childCol = col + cc * childSize;
            // Check all base cells in this child
            for (
              let br = childRow;
              br < childRow + childSize && canMerge;
              br++
            ) {
              for (
                let bc = childCol;
                bc < childCol + childSize && canMerge;
                bc++
              ) {
                if (cellLevel[br * (cols - 1) + bc] !== level - 1) {
                  canMerge = false;
                }
              }
            }
          }
        }

        if (!canMerge) continue;

        // Check interpolation error: can the 4 corners of the parent cell
        // adequately represent all interior points?
        const error = computeCellError(
          col,
          row,
          cellSize,
          cols,
          amplitudeFactor,
          directionOffset,
          phaseOffset,
        );

        if (error < SIMPLIFY_THRESHOLD) {
          // Merge: set all base cells to this level
          for (let br = row; br < row + cellSize; br++) {
            for (let bc = col; bc < col + cellSize; bc++) {
              if (br < rows - 1 && bc < cols - 1) {
                cellLevel[br * (cols - 1) + bc] = level;
              }
            }
          }
        }
      }
    }
  }

  // Enforce 2:1 grading
  enforce21Grading(cellLevel, cols - 1, rows - 1);

  // Collect unique cells
  const cells: QuadCell[] = [];
  const visited = new Uint8Array((cols - 1) * (rows - 1));

  for (let row = 0; row < rows - 1; row++) {
    for (let col = 0; col < cols - 1; col++) {
      if (visited[row * (cols - 1) + col]) continue;
      const level = cellLevel[row * (cols - 1) + col];
      const size = 1 << level;

      // Verify this is the top-left corner of the cell
      if (row % size !== 0 || col % size !== 0) continue;

      // Mark all base cells in this cell as visited
      for (let br = row; br < Math.min(row + size, rows - 1); br++) {
        for (let bc = col; bc < Math.min(col + size, cols - 1); bc++) {
          visited[br * (cols - 1) + bc] = 1;
        }
      }

      cells.push({ col, row, size, level });
    }
  }

  // Triangulate cells with T-junction handling
  return triangulateCells(
    cells,
    cellLevel,
    cols,
    rows,
    minX,
    minY,
    amplitudeFactor,
    directionOffset,
    phaseOffset,
  );
}

/**
 * Compute the max interpolation error for a cell.
 * Checks all interior grid points against bilinear interpolation from the 4 corners.
 */
function computeCellError(
  col: number,
  row: number,
  size: number,
  cols: number,
  amplitudeFactor: Float32Array,
  directionOffset: Float32Array,
  phaseOffset: Float32Array,
): number {
  // Corner values
  const tl = row * cols + col;
  const tr = row * cols + col + size;
  const bl = (row + size) * cols + col;
  const br = (row + size) * cols + col + size;

  const ampTL = amplitudeFactor[tl];
  const ampTR = amplitudeFactor[tr];
  const ampBL = amplitudeFactor[bl];
  const ampBR = amplitudeFactor[br];

  const dirTL = directionOffset[tl];
  const dirTR = directionOffset[tr];
  const dirBL = directionOffset[bl];
  const dirBR = directionOffset[br];

  const phaTL = phaseOffset[tl];
  const phaTR = phaseOffset[tr];
  const phaBL = phaseOffset[bl];
  const phaBR = phaseOffset[br];

  let maxError = 0;

  for (let r = row; r <= row + size; r++) {
    for (let c = col; c <= col + size; c++) {
      // Skip corners
      if (
        (r === row && c === col) ||
        (r === row && c === col + size) ||
        (r === row + size && c === col) ||
        (r === row + size && c === col + size)
      ) {
        continue;
      }

      const idx = r * cols + c;
      const fx = (c - col) / size;
      const fy = (r - row) / size;

      // Bilinear interpolation
      const interpAmp =
        ampTL * (1 - fx) * (1 - fy) +
        ampTR * fx * (1 - fy) +
        ampBL * (1 - fx) * fy +
        ampBR * fx * fy;
      const interpDir =
        dirTL * (1 - fx) * (1 - fy) +
        dirTR * fx * (1 - fy) +
        dirBL * (1 - fx) * fy +
        dirBR * fx * fy;
      const interpPha =
        phaTL * (1 - fx) * (1 - fy) +
        phaTR * fx * (1 - fy) +
        phaBL * (1 - fx) * fy +
        phaBR * fx * fy;

      const errAmp = Math.abs(amplitudeFactor[idx] - interpAmp);
      const errDir = Math.abs(directionOffset[idx] - interpDir) / 0.5;
      const errPha = Math.abs(phaseOffset[idx] - interpPha) / Math.PI;

      const error = Math.max(errAmp, errDir, errPha);
      if (error > maxError) maxError = error;
    }
  }

  return maxError;
}

/**
 * Enforce 2:1 grading constraint.
 * No cell should differ by more than 1 level from its neighbor.
 */
function enforce21Grading(
  cellLevel: Uint8Array,
  gridCols: number,
  gridRows: number,
): void {
  // Iterate until no changes
  let changed = true;
  while (changed) {
    changed = false;
    for (let row = 0; row < gridRows; row++) {
      for (let col = 0; col < gridCols; col++) {
        const level = cellLevel[row * gridCols + col];
        if (level === 0) continue;

        const size = 1 << level;
        // Check if this is a top-left corner
        if (row % size !== 0 || col % size !== 0) continue;

        // Check neighbors of this cell
        // Right neighbor
        if (col + size < gridCols) {
          const neighborLevel = cellLevel[row * gridCols + col + size];
          if (level - neighborLevel > 1) {
            // Split this cell
            splitCell(cellLevel, col, row, level, gridCols, gridRows);
            changed = true;
            continue;
          }
        }
        // Bottom neighbor
        if (row + size < gridRows) {
          const neighborLevel = cellLevel[(row + size) * gridCols + col];
          if (level - neighborLevel > 1) {
            splitCell(cellLevel, col, row, level, gridCols, gridRows);
            changed = true;
            continue;
          }
        }
        // Left neighbor
        if (col > 0) {
          const neighborLevel = cellLevel[row * gridCols + col - 1];
          if (level - neighborLevel > 1) {
            splitCell(cellLevel, col, row, level, gridCols, gridRows);
            changed = true;
            continue;
          }
        }
        // Top neighbor
        if (row > 0) {
          const neighborLevel = cellLevel[(row - 1) * gridCols + col];
          if (level - neighborLevel > 1) {
            splitCell(cellLevel, col, row, level, gridCols, gridRows);
            changed = true;
            continue;
          }
        }
      }
    }
  }
}

function splitCell(
  cellLevel: Uint8Array,
  col: number,
  row: number,
  level: number,
  gridCols: number,
  gridRows: number,
): void {
  const newLevel = level - 1;
  const size = 1 << level;
  for (let br = row; br < Math.min(row + size, gridRows); br++) {
    for (let bc = col; bc < Math.min(col + size, gridCols); bc++) {
      cellLevel[br * gridCols + bc] = newLevel;
    }
  }
}

/**
 * Triangulate the quadtree cells, handling T-junctions at boundaries
 * where cells of different sizes meet.
 */
function triangulateCells(
  cells: QuadCell[],
  cellLevel: Uint8Array,
  cols: number,
  rows: number,
  minX: number,
  minY: number,
  amplitudeFactor: Float32Array,
  directionOffset: Float32Array,
  phaseOffset: Float32Array,
): WavefrontMeshData {
  // Build a map from grid point to vertex index
  const vertexMap = new Map<number, number>();
  const vertexList: number[] = []; // flat: [gridIdx, gridIdx, ...]

  function getOrCreateVertex(gridIdx: number): number {
    let vi = vertexMap.get(gridIdx);
    if (vi === undefined) {
      vi = vertexList.length;
      vertexList.push(gridIdx);
      vertexMap.set(gridIdx, vi);
    }
    return vi;
  }

  // Build a lookup to quickly find the cell level at any base cell position
  const gridCols = cols - 1;

  // For each cell, determine hanging nodes on each edge and triangulate
  const triangles: number[] = []; // vertex indices, 3 per triangle

  for (const cell of cells) {
    const { col, row, size } = cell;

    // Corner grid indices
    const iTL = row * cols + col;
    const iTR = row * cols + col + size;
    const iBL = (row + size) * cols + col;
    const iBR = (row + size) * cols + col + size;

    const vTL = getOrCreateVertex(iTL);
    const vTR = getOrCreateVertex(iTR);
    const vBL = getOrCreateVertex(iBL);
    const vBR = getOrCreateVertex(iBR);

    // Find hanging nodes on each edge
    // An edge has a hanging node if the neighbor cell is smaller (lower level)
    const topHanging = findHangingNodes(
      col,
      row,
      size,
      "top",
      cellLevel,
      gridCols,
      cols,
      rows,
    );
    const bottomHanging = findHangingNodes(
      col,
      row,
      size,
      "bottom",
      cellLevel,
      gridCols,
      cols,
      rows,
    );
    const leftHanging = findHangingNodes(
      col,
      row,
      size,
      "left",
      cellLevel,
      gridCols,
      cols,
      rows,
    );
    const rightHanging = findHangingNodes(
      col,
      row,
      size,
      "right",
      cellLevel,
      gridCols,
      cols,
      rows,
    );

    const hasHanging =
      topHanging.length > 0 ||
      bottomHanging.length > 0 ||
      leftHanging.length > 0 ||
      rightHanging.length > 0;

    if (!hasHanging) {
      // Simple case: 2 triangles
      triangles.push(vTL, vBL, vTR);
      triangles.push(vTR, vBL, vBR);
    } else {
      // Fan triangulation from center
      const centerGridCol = col + size / 2;
      const centerGridRow = row + size / 2;
      // If size is odd in grid cells, we need to handle it.
      // Since size is always a power of 2, size/2 is always integer.
      const centerIdx = centerGridRow * cols + centerGridCol;
      const vCenter = getOrCreateVertex(centerIdx);

      // Build ordered boundary vertices (clockwise starting from TL)
      const boundary: number[] = [];

      // Top edge: TL -> TR
      boundary.push(vTL);
      for (const hi of topHanging) {
        boundary.push(getOrCreateVertex(hi));
      }

      // Right edge: TR -> BR
      boundary.push(vTR);
      for (const hi of rightHanging) {
        boundary.push(getOrCreateVertex(hi));
      }

      // Bottom edge: BR -> BL
      boundary.push(vBR);
      for (const hi of bottomHanging.reverse()) {
        boundary.push(getOrCreateVertex(hi));
      }

      // Left edge: BL -> TL
      boundary.push(vBL);
      for (const hi of leftHanging.reverse()) {
        boundary.push(getOrCreateVertex(hi));
      }

      // Fan triangulation from center to boundary
      for (let i = 0; i < boundary.length; i++) {
        const next = (i + 1) % boundary.length;
        triangles.push(vCenter, boundary[i], boundary[next]);
      }
    }
  }

  // Build output arrays
  const vertexCount = vertexList.length;
  const indexCount = triangles.length;
  const vertices = new Float32Array(vertexCount * VERTEX_FLOATS);
  const indices = new Uint32Array(indexCount);

  for (let i = 0; i < vertexCount; i++) {
    const gridIdx = vertexList[i];
    const gridCol = gridIdx % cols;
    const gridRow = (gridIdx - gridCol) / cols;
    const base = i * VERTEX_FLOATS;
    vertices[base + 0] = minX + gridCol * GRID_SPACING;
    vertices[base + 1] = minY + gridRow * GRID_SPACING;
    vertices[base + 2] = amplitudeFactor[gridIdx];
    vertices[base + 3] = directionOffset[gridIdx];
    vertices[base + 4] = phaseOffset[gridIdx];
    const isBoundary =
      gridRow === 0 ||
      gridRow === rows - 1 ||
      gridCol === 0 ||
      gridCol === cols - 1;
    vertices[base + 5] = isBoundary ? 0.0 : 1.0;
  }

  for (let i = 0; i < indexCount; i++) {
    indices[i] = triangles[i];
  }

  return { vertices, indices, vertexCount, indexCount, coverageQuad: null };
}

/**
 * Find hanging node grid indices along a cell edge.
 * Returns grid indices of midpoints that need to be inserted.
 */
function findHangingNodes(
  col: number,
  row: number,
  size: number,
  edge: "top" | "bottom" | "left" | "right",
  cellLevel: Uint8Array,
  gridCols: number,
  cols: number,
  rows: number,
): number[] {
  const result: number[] = [];

  // Check neighbor cells along this edge
  // A hanging node exists at the midpoint of each sub-cell boundary
  // along the edge where the neighbor is at a finer level.

  switch (edge) {
    case "top": {
      if (row === 0) return result;
      // Check cells along the top edge (row - 1)
      const neighborRow = row - 1;
      // Collect distinct midpoints
      for (let c = col; c < col + size; c++) {
        if (c >= gridCols) continue;
        const nLevel = cellLevel[neighborRow * gridCols + c];
        const nSize = 1 << nLevel;
        // If the neighbor is smaller than our cell, there's a hanging node
        // at each sub-cell boundary within our edge
        if (nSize < size) {
          // The midpoint at grid position (row, c + nSize) is a hanging node
          // if it's not one of our corners
          const midCol = c + nSize;
          if (midCol > col && midCol < col + size) {
            const gridIdx = row * cols + midCol;
            if (!result.includes(gridIdx)) {
              result.push(gridIdx);
            }
          }
        }
      }
      // Sort by column
      result.sort((a, b) => (a % cols) - (b % cols));
      return result;
    }
    case "bottom": {
      const edgeRow = row + size;
      if (edgeRow >= rows) return result;
      const neighborRow = edgeRow;
      if (neighborRow >= rows - 1) return result;
      for (let c = col; c < col + size; c++) {
        if (c >= gridCols) continue;
        const nLevel = cellLevel[neighborRow * gridCols + c];
        const nSize = 1 << nLevel;
        if (nSize < size) {
          const midCol = c + nSize;
          if (midCol > col && midCol < col + size) {
            const gridIdx = edgeRow * cols + midCol;
            if (!result.includes(gridIdx)) {
              result.push(gridIdx);
            }
          }
        }
      }
      result.sort((a, b) => (a % cols) - (b % cols));
      return result;
    }
    case "left": {
      if (col === 0) return result;
      const neighborCol = col - 1;
      for (let r = row; r < row + size; r++) {
        if (r >= rows - 1) continue;
        const nLevel = cellLevel[r * gridCols + neighborCol];
        const nSize = 1 << nLevel;
        if (nSize < size) {
          const midRow = r + nSize;
          if (midRow > row && midRow < row + size) {
            const gridIdx = midRow * cols + col;
            if (!result.includes(gridIdx)) {
              result.push(gridIdx);
            }
          }
        }
      }
      result.sort((a, b) => Math.floor(a / cols) - Math.floor(b / cols));
      return result;
    }
    case "right": {
      const edgeCol = col + size;
      if (edgeCol >= cols) return result;
      if (edgeCol >= gridCols) return result;
      for (let r = row; r < row + size; r++) {
        if (r >= rows - 1) continue;
        const nLevel = cellLevel[r * gridCols + edgeCol];
        const nSize = 1 << nLevel;
        if (nSize < size) {
          const midRow = r + nSize;
          if (midRow > row && midRow < row + size) {
            const gridIdx = midRow * cols + edgeCol;
            if (!result.includes(gridIdx)) {
              result.push(gridIdx);
            }
          }
        }
      }
      result.sort((a, b) => Math.floor(a / cols) - Math.floor(b / cols));
      return result;
    }
  }
}
