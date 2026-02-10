/**
 * Terrain-Seeded Eulerian wavefront mesh builder.
 *
 * Seeds vertex positions from terrain contour data (dense near coastlines,
 * sparse in open ocean), triangulates via Bowyer-Watson Delaunay, then
 * solves wave properties via Fast Marching Method on the unstructured mesh.
 *
 * No engine imports — runs in a web worker.
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

/** Number of floats per output vertex */
const VERTEX_FLOATS = 6;

/** Number of 32-bit values per contour metadata entry */
const FLOATS_PER_CONTOUR = 13;

/** Gravity in ft/s^2 */
const GRAVITY = 32.174;

/** 2 * PI */
const TWO_PI = 2 * Math.PI;

// =============================================================================
// Contour data accessors (mirrors terrainHeight.ts but local for convenience)
// =============================================================================

interface ContourInfo {
  pointStartIndex: number;
  pointCount: number;
  height: number;
  isCoastline: number;
  bboxMinX: number;
  bboxMinY: number;
  bboxMaxX: number;
  bboxMaxY: number;
}

function readContourInfo(
  terrain: TerrainDataForWorker,
  contourIndex: number,
): ContourInfo {
  const view = new DataView(terrain.contourData);
  const byteBase = contourIndex * FLOATS_PER_CONTOUR * 4;
  return {
    pointStartIndex: view.getUint32(byteBase + 0, true),
    pointCount: view.getUint32(byteBase + 4, true),
    height: view.getFloat32(byteBase + 8, true),
    isCoastline: view.getUint32(byteBase + 28, true),
    bboxMinX: view.getFloat32(byteBase + 32, true),
    bboxMinY: view.getFloat32(byteBase + 36, true),
    bboxMaxX: view.getFloat32(byteBase + 40, true),
    bboxMaxY: view.getFloat32(byteBase + 44, true),
  };
}

function readTerrainVertex(
  terrain: TerrainDataForWorker,
  index: number,
): [number, number] {
  const base = index * 2;
  return [terrain.vertexData[base], terrain.vertexData[base + 1]];
}

// =============================================================================
// Phase 1: Vertex Seeding
// =============================================================================

interface SeededVertex {
  x: number;
  y: number;
  isLand: boolean;
}

interface SeedResult {
  vertices: SeededVertex[];
  boundsMinX: number;
  boundsMaxX: number;
  boundsMinY: number;
  boundsMaxY: number;
  gridSpacing: number;
}

/**
 * Seed vertices from terrain contours, coastline densification,
 * leeward diffraction zones, and open ocean fill.
 */
function seedVertices(
  waveSource: WaveSource,
  coastlineBounds: MeshBuildBounds | null,
  terrain: TerrainDataForWorker,
  tideHeight: number,
): SeedResult {
  const wavelength = waveSource.wavelength;
  const waveDir = waveSource.direction;
  const waveDx = Math.cos(waveDir);
  const waveDy = Math.sin(waveDir);

  const vertices: SeededVertex[] = [];

  // Spatial hash for deduplication — avoid placing vertices too close together
  const minSpacing = wavelength / 8;
  const minSpacingSq = minSpacing * minSpacing;
  const cellSize = minSpacing;
  const spatialHash = new Map<number, SeededVertex[]>();

  function hashKey(x: number, y: number): number {
    const cx = Math.floor(x / cellSize);
    const cy = Math.floor(y / cellSize);
    return cx * 73856093 + cy * 19349663;
  }

  function hasNearbyVertex(x: number, y: number): boolean {
    const cx = Math.floor(x / cellSize);
    const cy = Math.floor(y / cellSize);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const key = (cx + dx) * 73856093 + (cy + dy) * 19349663;
        const bucket = spatialHash.get(key);
        if (bucket) {
          for (const v of bucket) {
            const ddx = v.x - x;
            const ddy = v.y - y;
            if (ddx * ddx + ddy * ddy < minSpacingSq) {
              return true;
            }
          }
        }
      }
    }
    return false;
  }

  function addVertex(x: number, y: number, isLand: boolean): void {
    if (!isFinite(x) || !isFinite(y)) return;
    if (hasNearbyVertex(x, y)) return;
    const v: SeededVertex = { x, y, isLand };
    vertices.push(v);
    const key = hashKey(x, y);
    let bucket = spatialHash.get(key);
    if (!bucket) {
      bucket = [];
      spatialHash.set(key, bucket);
    }
    bucket.push(v);
  }

  // --- 1a. Contour vertices ---
  const coastlineContours: number[] = [];

  for (let ci = 0; ci < terrain.contourCount; ci++) {
    const info = readContourInfo(terrain, ci);
    if (info.isCoastline) {
      coastlineContours.push(ci);
    }
    const isAboveWater = info.height > tideHeight;
    for (let vi = 0; vi < info.pointCount; vi++) {
      const [vx, vy] = readTerrainVertex(terrain, info.pointStartIndex + vi);
      addVertex(vx, vy, isAboveWater);
    }
  }

  // --- 1b. Near-coastline densification ---
  for (const ci of coastlineContours) {
    const info = readContourInfo(terrain, ci);
    const n = info.pointCount;
    const start = info.pointStartIndex;

    for (let vi = 0; vi < n; vi++) {
      const [ax, ay] = readTerrainVertex(terrain, start + vi);
      const [bx, by] = readTerrainVertex(terrain, start + ((vi + 1) % n));

      // Edge normal (outward for CCW winding)
      const edgeDx = bx - ax;
      const edgeDy = by - ay;
      const edgeLen = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy);
      if (edgeLen < 1e-6) continue;

      // Outward normal: rotate edge 90 degrees clockwise
      const nx = edgeDy / edgeLen;
      const ny = -edgeDx / edgeLen;

      // Midpoint of edge
      const mx = (ax + bx) * 0.5;
      const my = (ay + by) * 0.5;

      // Place vertices along the outward normal at intervals
      const step = wavelength / 8;
      const maxDist = wavelength * 2;
      for (let d = step; d <= maxDist; d += step) {
        const px = mx + nx * d;
        const py = my + ny * d;
        // Skip if inside land
        const height = computeTerrainHeight(px, py, terrain);
        if (height > tideHeight) continue;
        addVertex(px, py, false);
      }
    }
  }

  // --- 1c. Leeward densification (diffraction zones) ---
  for (const ci of coastlineContours) {
    const info = readContourInfo(terrain, ci);
    const n = info.pointCount;
    const start = info.pointStartIndex;

    // Find silhouette points (edges where windward/leeward classification changes)
    for (let vi = 0; vi < n; vi++) {
      const [ax, ay] = readTerrainVertex(terrain, start + vi);
      const [bx, by] = readTerrainVertex(terrain, start + ((vi + 1) % n));

      const edgeDx = bx - ax;
      const edgeDy = by - ay;
      const edgeLen = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy);
      if (edgeLen < 1e-6) continue;

      // Outward normal
      const nx = edgeDy / edgeLen;
      const ny = -edgeDx / edgeLen;

      // dot(normal, waveDir) — positive means facing the wave, negative means leeward
      const dotWind = nx * waveDx + ny * waveDy;

      // Check next edge to find silhouette transitions
      const ni2 = (vi + 1) % n;
      const [cx, cy] = readTerrainVertex(terrain, start + ((ni2 + 1) % n));
      const edgeDx2 = cx - bx;
      const edgeDy2 = cy - by;
      const edgeLen2 = Math.sqrt(edgeDx2 * edgeDx2 + edgeDy2 * edgeDy2);
      if (edgeLen2 < 1e-6) continue;

      const nx2 = edgeDy2 / edgeLen2;
      const ny2 = -edgeDx2 / edgeLen2;
      const dotWind2 = nx2 * waveDx + ny2 * waveDy;

      // Silhouette: transition from windward to leeward
      if (dotWind >= 0 && dotWind2 < 0) {
        // b is a silhouette point — fan vertices into shadow zone
        const distances = [
          wavelength / 4,
          wavelength / 2,
          wavelength,
          wavelength * 2,
        ];
        // Shadow direction: opposite to wave direction
        const shadowDx = -waveDx;
        const shadowDy = -waveDy;

        // Fan across ~90 degrees into shadow zone
        const fanAngles = [
          -Math.PI / 4,
          -Math.PI / 8,
          0,
          Math.PI / 8,
          Math.PI / 4,
        ];
        for (const dist of distances) {
          for (const angle of fanAngles) {
            const cosA = Math.cos(angle);
            const sinA = Math.sin(angle);
            const dx = shadowDx * cosA - shadowDy * sinA;
            const dy = shadowDx * sinA + shadowDy * cosA;
            const px = bx + dx * dist;
            const py = by + dy * dist;
            const height = computeTerrainHeight(px, py, terrain);
            if (height > tideHeight) continue;
            addVertex(px, py, false);
          }
        }
      }
    }
  }

  // --- 1d. Open ocean fill ---
  const gridSpacing = wavelength * 2;
  let boundsMinX: number,
    boundsMaxX: number,
    boundsMinY: number,
    boundsMaxY: number;

  if (coastlineBounds) {
    const margin = Math.max(2000, wavelength * 3);
    boundsMinX = coastlineBounds.minX - margin;
    boundsMaxX = coastlineBounds.maxX + margin;
    boundsMinY = coastlineBounds.minY - margin;
    boundsMaxY = coastlineBounds.maxY + margin;
  } else {
    boundsMinX = -1000;
    boundsMaxX = 1000;
    boundsMinY = -1000;
    boundsMaxY = 1000;
  }

  for (let gx = boundsMinX; gx <= boundsMaxX; gx += gridSpacing) {
    for (let gy = boundsMinY; gy <= boundsMaxY; gy += gridSpacing) {
      const height = computeTerrainHeight(gx, gy, terrain);
      if (height > tideHeight) continue;
      addVertex(gx, gy, false);
    }
  }

  return {
    vertices,
    boundsMinX,
    boundsMaxX,
    boundsMinY,
    boundsMaxY,
    gridSpacing,
  };
}

// =============================================================================
// Phase 2: Delaunay Triangulation (Bowyer-Watson)
// =============================================================================

interface Triangle {
  a: number;
  b: number;
  c: number;
  /** Circumcircle center x */
  cx: number;
  /** Circumcircle center y */
  cy: number;
  /** Circumcircle radius squared */
  rSq: number;
}

function computeCircumcircle(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): { cx: number; cy: number; rSq: number } {
  const dax = ax - cx;
  const day = ay - cy;
  const dbx = bx - cx;
  const dby = by - cy;

  const denom = 2 * (dax * dby - day * dbx);
  if (Math.abs(denom) < 1e-12) {
    // Degenerate triangle — use huge circumcircle
    return { cx: (ax + bx + cx) / 3, cy: (ay + by + cy) / 3, rSq: 1e20 };
  }

  const daSq = dax * dax + day * day;
  const dbSq = dbx * dbx + dby * dby;

  const ccx = cx + (daSq * dby - dbSq * day) / denom;
  const ccy = cy + (dbSq * dax - daSq * dbx) / denom;
  const dx = ax - ccx;
  const dy = ay - ccy;

  return { cx: ccx, cy: ccy, rSq: dx * dx + dy * dy };
}

/**
 * Bowyer-Watson Delaunay triangulation.
 * Returns list of triangles referencing point indices.
 */
function delaunayTriangulate(
  points: { x: number; y: number }[],
): { a: number; b: number; c: number }[] {
  const n = points.length;
  if (n < 3) return [];

  // Compute bounding box
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  const dx = maxX - minX;
  const dy = maxY - minY;
  const dmax = Math.max(dx, dy);
  const midX = (minX + maxX) * 0.5;
  const midY = (minY + maxY) * 0.5;

  // Create super-triangle vertices (indices n, n+1, n+2)
  const superPoints = [
    { x: midX - 20 * dmax, y: midY - dmax },
    { x: midX, y: midY + 20 * dmax },
    { x: midX + 20 * dmax, y: midY - dmax },
  ];

  const allPoints = [...points, ...superPoints];

  // Initial super-triangle
  const cc = computeCircumcircle(
    superPoints[0].x,
    superPoints[0].y,
    superPoints[1].x,
    superPoints[1].y,
    superPoints[2].x,
    superPoints[2].y,
  );

  const triangles: Triangle[] = [
    { a: n, b: n + 1, c: n + 2, cx: cc.cx, cy: cc.cy, rSq: cc.rSq },
  ];

  // Insert each point one at a time
  for (let i = 0; i < n; i++) {
    const px = allPoints[i].x;
    const py = allPoints[i].y;

    // Find all triangles whose circumcircle contains this point
    const badTriangles: number[] = [];
    for (let t = 0; t < triangles.length; t++) {
      const tri = triangles[t];
      const ddx = px - tri.cx;
      const ddy = py - tri.cy;
      if (ddx * ddx + ddy * ddy <= tri.rSq) {
        badTriangles.push(t);
      }
    }

    // Find the polygon hole boundary (edges of bad triangles not shared by another bad triangle)
    const edgeMap = new Map<string, { a: number; b: number; count: number }>();

    for (const ti of badTriangles) {
      const tri = triangles[ti];
      const edges = [
        [tri.a, tri.b],
        [tri.b, tri.c],
        [tri.c, tri.a],
      ];
      for (const [ea, eb] of edges) {
        const key = ea < eb ? `${ea},${eb}` : `${eb},${ea}`;
        const existing = edgeMap.get(key);
        if (existing) {
          existing.count++;
        } else {
          edgeMap.set(key, { a: ea, b: eb, count: 1 });
        }
      }
    }

    // Remove bad triangles (in reverse index order to preserve indices)
    badTriangles.sort((a, b) => b - a);
    for (const ti of badTriangles) {
      triangles.splice(ti, 1);
    }

    // Create new triangles from point to each boundary edge
    for (const edge of edgeMap.values()) {
      if (edge.count !== 1) continue; // shared edge, not on boundary

      const pa = allPoints[edge.a];
      const pb = allPoints[edge.b];
      const pi = allPoints[i];
      const newCC = computeCircumcircle(pa.x, pa.y, pb.x, pb.y, pi.x, pi.y);
      triangles.push({
        a: edge.a,
        b: edge.b,
        c: i,
        cx: newCC.cx,
        cy: newCC.cy,
        rSq: newCC.rSq,
      });
    }
  }

  // Remove triangles that reference super-triangle vertices
  const result: { a: number; b: number; c: number }[] = [];
  for (const tri of triangles) {
    if (tri.a >= n || tri.b >= n || tri.c >= n) continue;
    result.push({ a: tri.a, b: tri.b, c: tri.c });
  }

  return result;
}

// =============================================================================
// Phase 3: Fast Marching Method on Triangle Mesh
// =============================================================================

const FMM_FAR = 0;
const FMM_TRIAL = 1;
const FMM_KNOWN = 2;
const FMM_BLOCKED = 3;

/**
 * Min-heap priority queue for FMM vertices, sorted by travel time.
 */
class MinHeap {
  private heap: number[] = [];
  private times: Float64Array;
  /** Position of each vertex in the heap (-1 if not in heap) */
  private positions: Int32Array;

  constructor(size: number, times: Float64Array) {
    this.times = times;
    this.positions = new Int32Array(size).fill(-1);
  }

  get size(): number {
    return this.heap.length;
  }

  insert(vertex: number): void {
    this.heap.push(vertex);
    this.positions[vertex] = this.heap.length - 1;
    this.bubbleUp(this.heap.length - 1);
  }

  extractMin(): number {
    const min = this.heap[0];
    const last = this.heap.pop()!;
    this.positions[min] = -1;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.positions[last] = 0;
      this.sinkDown(0);
    }
    return min;
  }

  decreaseKey(vertex: number): void {
    const pos = this.positions[vertex];
    if (pos >= 0) {
      this.bubbleUp(pos);
    }
  }

  contains(vertex: number): boolean {
    return this.positions[vertex] >= 0;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.times[this.heap[i]] < this.times[this.heap[parent]]) {
        this.swap(i, parent);
        i = parent;
      } else {
        break;
      }
    }
  }

  private sinkDown(i: number): void {
    const n = this.heap.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (
        left < n &&
        this.times[this.heap[left]] < this.times[this.heap[smallest]]
      ) {
        smallest = left;
      }
      if (
        right < n &&
        this.times[this.heap[right]] < this.times[this.heap[smallest]]
      ) {
        smallest = right;
      }
      if (smallest !== i) {
        this.swap(i, smallest);
        i = smallest;
      } else {
        break;
      }
    }
  }

  private swap(a: number, b: number): void {
    const va = this.heap[a];
    const vb = this.heap[b];
    this.heap[a] = vb;
    this.heap[b] = va;
    this.positions[va] = b;
    this.positions[vb] = a;
  }
}

/**
 * Build adjacency: for each vertex, list of (neighborVertex, triangleIndex) pairs.
 * Also build per-triangle adjacency for gradient computation.
 */
function buildAdjacency(
  vertexCount: number,
  triangles: { a: number; b: number; c: number }[],
): {
  /** For each vertex, set of neighbor vertex indices */
  vertexNeighbors: Set<number>[];
  /** For each vertex, list of triangle indices it belongs to */
  vertexTriangles: number[][];
} {
  const vertexNeighbors: Set<number>[] = new Array(vertexCount);
  const vertexTriangles: number[][] = new Array(vertexCount);

  for (let i = 0; i < vertexCount; i++) {
    vertexNeighbors[i] = new Set();
    vertexTriangles[i] = [];
  }

  for (let ti = 0; ti < triangles.length; ti++) {
    const { a, b, c } = triangles[ti];
    vertexNeighbors[a].add(b);
    vertexNeighbors[a].add(c);
    vertexNeighbors[b].add(a);
    vertexNeighbors[b].add(c);
    vertexNeighbors[c].add(a);
    vertexNeighbors[c].add(b);
    vertexTriangles[a].push(ti);
    vertexTriangles[b].push(ti);
    vertexTriangles[c].push(ti);
  }

  return { vertexNeighbors, vertexTriangles };
}

/**
 * Eikonal update for vertex C given known vertices A and B sharing a triangle.
 * Returns tentative travel time at C.
 */
function eikonalTriangleUpdate(
  ax: number,
  ay: number,
  tA: number,
  bx: number,
  by: number,
  tB: number,
  cx: number,
  cy: number,
  speed: number,
): number {
  // Slowness = 1/speed
  const slowness = 1.0 / speed;

  // Vectors from A
  const abx = bx - ax;
  const aby = by - ay;
  const acx = cx - ax;
  const acy = cy - ay;

  const abLen = Math.sqrt(abx * abx + aby * aby);
  if (abLen < 1e-10) {
    // Degenerate: A and B coincide, use 1D update from A
    const dist = Math.sqrt(acx * acx + acy * acy);
    return tA + dist * slowness;
  }

  // Length of AC
  const acLen = Math.sqrt(acx * acx + acy * acy);

  // Use the triangle update method:
  // Let u = tB - tA (gradient along AB)
  const u = tB - tA;

  // Dot products
  const abDotAc = abx * acx + aby * acy;

  // Project: we solve the quadratic equation for the eikonal
  // Let the parametric point on AB be P = A + t*(B-A) for t in [0,1]
  // T_C = T_P + dist(P,C) / speed
  // T_P = T_A + t * u  (linear interpolation, valid for Delaunay FMM update)
  // Minimize T_C = T_A + t*u + dist(P,C)*slowness

  // dist(P,C)^2 = |AC|^2 - 2*t*(AB.AC) + t^2*|AB|^2
  // = acLen^2 - 2*t*abDotAc + t^2*abLen^2

  // To find minimum, take derivative and set to 0:
  // d/dt [t*u + slowness * sqrt(acLen^2 - 2*t*abDotAc + t^2*abLen^2)] = 0

  // Solve quadratic: (abLen^2 * slowness^2 - u^2) * t^2 + 2*(u*abDotAc - abLen^2*slowness^2)*... etc
  // Use the standard approach

  const a2 = abLen * abLen;
  const b2 = -2 * abDotAc;
  const c2 = acLen * acLen;

  // The quadratic from the eikonal: (slowness^2 * a2 - u^2)*t^2 + (slowness^2*b2 + 2*u*...
  // Simplified derivation:
  // f(t) = u*t + slowness * sqrt(a2*t^2 + b2*t + c2)
  // f'(t) = u + slowness * (2*a2*t + b2) / (2*sqrt(a2*t^2 + b2*t + c2)) = 0
  // => slowness * (2*a2*t + b2) = -2*u * sqrt(a2*t^2 + b2*t + c2)

  // Square both sides:
  // slowness^2 * (2*a2*t + b2)^2 = 4*u^2 * (a2*t^2 + b2*t + c2)

  // Expand: slowness^2 * (4*a2^2*t^2 + 4*a2*b2*t + b2^2) = 4*u^2*(a2*t^2 + b2*t + c2)
  // (4*a2^2*slowness^2 - 4*a2*u^2)*t^2 + (4*a2*b2*slowness^2 - 4*b2*u^2)*t + (b2^2*slowness^2 - 4*c2*u^2) = 0

  const s2 = slowness * slowness;
  const qa = 4 * a2 * a2 * s2 - 4 * a2 * u * u;
  const qb = 4 * a2 * b2 * s2 - 4 * b2 * u * u;
  const qc = b2 * b2 * s2 - 4 * c2 * u * u;

  let bestT = Infinity;

  // Try to solve quadratic
  if (Math.abs(qa) > 1e-12) {
    const disc = qb * qb - 4 * qa * qc;
    if (disc >= 0) {
      const sqrtDisc = Math.sqrt(disc);
      const t1 = (-qb + sqrtDisc) / (2 * qa);
      const t2 = (-qb - sqrtDisc) / (2 * qa);

      for (const t of [t1, t2]) {
        if (t >= 0 && t <= 1) {
          const distSq = a2 * t * t + b2 * t + c2;
          if (distSq > 0) {
            const val = tA + u * t + slowness * Math.sqrt(distSq);
            if (val < bestT) {
              bestT = val;
            }
          }
        }
      }
    }
  }

  // Fall back to 1D edge updates (from vertex A and from vertex B)
  const distAC = acLen;
  const distBC = Math.sqrt((cx - bx) * (cx - bx) + (cy - by) * (cy - by));

  const fromA = tA + distAC * slowness;
  const fromB = tB + distBC * slowness;

  bestT = Math.min(bestT, fromA, fromB);

  return bestT;
}

/**
 * Run Fast Marching Method to compute travel times from the wave source.
 * Returns travel time for each vertex.
 */
function fastMarchingMethod(
  vertices: SeededVertex[],
  triangles: { a: number; b: number; c: number }[],
  vertexNeighbors: Set<number>[],
  vertexTriangles: number[][],
  waveSource: WaveSource,
  terrain: TerrainDataForWorker,
  tideHeight: number,
): { travelTime: Float64Array; minDot: number } {
  const n = vertices.length;
  const wavelength = waveSource.wavelength;
  const waveDir = waveSource.direction;
  const waveDx = Math.cos(waveDir);
  const waveDy = Math.sin(waveDir);

  // Deep water speed
  const deepDepth = wavelength; // well above half-wavelength threshold
  const cDeep = computeWaveSpeed(wavelength, deepDepth);

  // Travel times
  const travelTime = new Float64Array(n).fill(Infinity);
  // Status array
  const status = new Uint8Array(n).fill(FMM_FAR);

  // Pre-compute depth and speed at each vertex
  const depth = new Float64Array(n);
  const speed = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (vertices[i].isLand) {
      status[i] = FMM_BLOCKED;
      depth[i] = 0;
      speed[i] = 0;
      continue;
    }
    const h = computeTerrainHeight(vertices[i].x, vertices[i].y, terrain);
    if (h > tideHeight) {
      status[i] = FMM_BLOCKED;
      depth[i] = 0;
      speed[i] = 0;
      continue;
    }
    const d = tideHeight - h;
    depth[i] = d;
    speed[i] = computeWaveSpeed(wavelength, Math.max(d, 0.1));
  }

  // Initialize ALL water vertices with planar travel time.
  // Open ocean already has the correct answer; the FMM only needs to correct
  // travel times near terrain where refraction/diffraction alter the wavefront.

  // Compute dot products and normalize so the most-upwind vertex has dot = 0.
  const dots = new Float64Array(n);
  let minDot = Infinity;
  for (let i = 0; i < n; i++) {
    if (status[i] === FMM_BLOCKED) continue;
    const dot = vertices[i].x * waveDx + vertices[i].y * waveDy;
    dots[i] = dot;
    if (dot < minDot) minDot = dot;
  }

  for (let i = 0; i < n; i++) {
    if (status[i] === FMM_BLOCKED) continue;
    dots[i] -= minDot;
  }

  // Set all water vertices to KNOWN with their planar travel time
  for (let i = 0; i < n; i++) {
    if (status[i] === FMM_BLOCKED) continue;
    travelTime[i] = dots[i] / cDeep;
    status[i] = FMM_KNOWN;
  }

  // Re-seed FMM from the terrain boundary: water vertices adjacent to land
  // need their travel times recomputed by the eikonal solver. Reset them to
  // TRIAL so the FMM propagates corrections outward from terrain.
  const heap = new MinHeap(n, travelTime);

  for (let i = 0; i < n; i++) {
    if (status[i] !== FMM_KNOWN) continue;
    let nearLand = false;
    for (const nb of vertexNeighbors[i]) {
      if (status[nb] === FMM_BLOCKED) {
        nearLand = true;
        break;
      }
    }
    if (nearLand) {
      status[i] = FMM_TRIAL;
      heap.insert(i);
    }
  }

  // Main FMM loop
  while (heap.size > 0) {
    const current = heap.extractMin();
    status[current] = FMM_KNOWN;

    // Update all non-KNOWN, non-BLOCKED neighbors
    for (const nb of vertexNeighbors[current]) {
      if (status[nb] === FMM_KNOWN || status[nb] === FMM_BLOCKED) continue;

      // Try triangle updates for each triangle containing both current and nb
      let bestTime = travelTime[nb];

      for (const ti of vertexTriangles[current]) {
        const tri = triangles[ti];
        const triVerts = [tri.a, tri.b, tri.c];

        // Check this triangle contains nb
        if (!triVerts.includes(nb)) continue;

        // Find the third vertex (not current and not nb)
        const third = triVerts.find((v) => v !== current && v !== nb);
        if (third === undefined) continue;

        // Speed at nb (use average of triangle vertex speeds for robustness)
        const spd =
          status[nb] === FMM_BLOCKED ? 0 : speed[nb] > 0 ? speed[nb] : cDeep;
        if (spd <= 0) continue;

        if (status[third] === FMM_KNOWN) {
          // Both current and third are KNOWN — do the full triangle update
          const t = eikonalTriangleUpdate(
            vertices[current].x,
            vertices[current].y,
            travelTime[current],
            vertices[third].x,
            vertices[third].y,
            travelTime[third],
            vertices[nb].x,
            vertices[nb].y,
            spd,
          );
          if (t < bestTime) bestTime = t;
        } else {
          // Only current is KNOWN — use 1D edge update
          const dist = Math.sqrt(
            (vertices[nb].x - vertices[current].x) ** 2 +
              (vertices[nb].y - vertices[current].y) ** 2,
          );
          const t = travelTime[current] + dist / spd;
          if (t < bestTime) bestTime = t;
        }
      }

      // If no triangle update helped, fall back to direct 1D edge update
      if (bestTime >= travelTime[nb]) {
        const spd = speed[nb] > 0 ? speed[nb] : cDeep;
        const dist = Math.sqrt(
          (vertices[nb].x - vertices[current].x) ** 2 +
            (vertices[nb].y - vertices[current].y) ** 2,
        );
        const t = travelTime[current] + dist / spd;
        if (t < bestTime) bestTime = t;
      }

      if (bestTime < travelTime[nb]) {
        travelTime[nb] = bestTime;
        if (status[nb] === FMM_TRIAL) {
          heap.decreaseKey(nb);
        } else {
          status[nb] = FMM_TRIAL;
          heap.insert(nb);
        }
      }
    }
  }

  return { travelTime, minDot };
}

// =============================================================================
// Phase 4: Derive Wave Properties
// =============================================================================

interface WaveProperties {
  amplitudeFactor: number;
  directionOffset: number;
  phaseOffset: number;
}

/**
 * Compute gradient of travel time at each vertex by averaging gradients from
 * incident triangles (weighted by triangle area).
 */
function computeTravelTimeGradient(
  vertices: SeededVertex[],
  triangles: { a: number; b: number; c: number }[],
  travelTime: Float64Array,
): { gradX: Float64Array; gradY: Float64Array } {
  const n = vertices.length;
  const gradX = new Float64Array(n);
  const gradY = new Float64Array(n);
  const totalWeight = new Float64Array(n);

  for (let ti = 0; ti < triangles.length; ti++) {
    const { a, b, c } = triangles[ti];

    const ax = vertices[a].x,
      ay = vertices[a].y;
    const bx = vertices[b].x,
      by = vertices[b].y;
    const cx = vertices[c].x,
      cy = vertices[c].y;

    // Signed area * 2
    const area2 = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    const absArea = Math.abs(area2);
    if (absArea < 1e-10) continue;

    const tA = travelTime[a];
    const tB = travelTime[b];
    const tC = travelTime[c];

    if (!isFinite(tA) || !isFinite(tB) || !isFinite(tC)) continue;

    // Gradient on the triangle: grad(T) = (1/2A) * sum of T_i * (n_i rotated 90)
    // Using the standard formula:
    // gradX = ((tA*(by-cy) + tB*(cy-ay) + tC*(ay-by))) / area2
    // gradY = ((tA*(cx-bx) + tB*(ax-cx) + tC*(bx-ax))) / area2
    const gx = (tA * (by - cy) + tB * (cy - ay) + tC * (ay - by)) / area2;
    const gy = (tA * (cx - bx) + tB * (ax - cx) + tC * (bx - ax)) / area2;

    // Weight by area and accumulate for each vertex
    const weight = absArea;
    for (const vi of [a, b, c]) {
      gradX[vi] += gx * weight;
      gradY[vi] += gy * weight;
      totalWeight[vi] += weight;
    }
  }

  // Normalize
  for (let i = 0; i < n; i++) {
    if (totalWeight[i] > 0) {
      gradX[i] /= totalWeight[i];
      gradY[i] /= totalWeight[i];
    }
  }

  return { gradX, gradY };
}

/**
 * Detect shadow zone vertices and compute diffraction amplitude correction.
 * A vertex is in the shadow zone if the FMM travel time is significantly
 * greater than the straight-line plane-wave travel time.
 */
function computeDiffractionFactor(
  vertex: SeededVertex,
  travelTime: number,
  waveSource: WaveSource,
  cDeep: number,
  minDotOffset: number,
): number {
  if (!isFinite(travelTime)) return 0;

  const wavelength = waveSource.wavelength;
  const waveDx = Math.cos(waveSource.direction);
  const waveDy = Math.sin(waveSource.direction);

  // Straight-line plane-wave travel time, normalized with the same offset
  // used during FMM initialization so both share the same reference frame.
  const planeT = (vertex.x * waveDx + vertex.y * waveDy - minDotOffset) / cDeep;

  // Delay beyond plane wave: larger delay means deeper in shadow zone
  const delay = travelTime - planeT;

  if (delay <= 0) {
    // Not in shadow zone (or ahead of the plane wave front — shouldn't happen much)
    return 1.0;
  }

  // Extra path length traveled
  const extraPath = delay * cDeep;

  // Fresnel number approximation:
  // F = sqrt(2 * extraPath / wavelength)
  // Diffraction coefficient: D ~ 0.5 at shadow boundary, decaying further in
  const F = Math.sqrt((2 * extraPath) / wavelength);

  if (F < 0.1) {
    // Near the shadow boundary — smooth transition
    return 0.5 + 0.5 * (1 - F / 0.1);
  }

  // Deeper in shadow: 1/(sqrt(2*pi*F))
  const D = 0.5 / Math.sqrt(1 + F);

  return Math.max(0.01, Math.min(1.0, D));
}

/**
 * Derive per-vertex wave properties from FMM travel times.
 */
function deriveWaveProperties(
  vertices: SeededVertex[],
  triangles: { a: number; b: number; c: number }[],
  travelTime: Float64Array,
  waveSource: WaveSource,
  terrain: TerrainDataForWorker,
  tideHeight: number,
  minDotOffset: number,
): WaveProperties[] {
  const n = vertices.length;
  const wavelength = waveSource.wavelength;
  const k = TWO_PI / wavelength;
  const omega = Math.sqrt(GRAVITY * k);
  const waveDir = waveSource.direction;
  const waveDx = Math.cos(waveDir);
  const waveDy = Math.sin(waveDir);

  // Deep water speed
  const cDeep = computeWaveSpeed(wavelength, wavelength);

  // Compute gradient of travel time
  const { gradX, gradY } = computeTravelTimeGradient(
    vertices,
    triangles,
    travelTime,
  );

  const properties: WaveProperties[] = new Array(n);

  for (let i = 0; i < n; i++) {
    if (vertices[i].isLand || !isFinite(travelTime[i])) {
      properties[i] = {
        amplitudeFactor: 0,
        directionOffset: 0,
        phaseOffset: 0,
      };
      continue;
    }

    // Direction from gradient of travel time
    const gx = gradX[i];
    const gy = gradY[i];
    const gLen = Math.sqrt(gx * gx + gy * gy);

    let direction: number;
    if (gLen > 1e-8) {
      direction = Math.atan2(gy, gx);
    } else {
      direction = waveDir;
    }

    // Direction offset
    let dirOffset = direction - waveDir;
    // Normalize to [-PI, PI]
    while (dirOffset > Math.PI) dirOffset -= TWO_PI;
    while (dirOffset < -Math.PI) dirOffset += TWO_PI;

    // Phase offset: use the same minDot normalization as the FMM travel times
    const truePhase = omega * travelTime[i];
    const planePhase =
      (vertices[i].x * waveDx + vertices[i].y * waveDy - minDotOffset) * k;
    let phaseOff = truePhase - planePhase;
    // Normalize to [-PI, PI]
    while (phaseOff > Math.PI) phaseOff -= TWO_PI;
    while (phaseOff < -Math.PI) phaseOff += TWO_PI;

    // Amplitude factor: terrain factor * diffraction factor
    const h = computeTerrainHeight(vertices[i].x, vertices[i].y, terrain);
    const d = tideHeight - h;
    const terrainFactor = computeWaveTerrainFactor(d, wavelength);
    const diffractionFactor = computeDiffractionFactor(
      vertices[i],
      travelTime[i],
      waveSource,
      cDeep,
      minDotOffset,
    );

    const amplitude = Math.max(
      0,
      Math.min(2.0, terrainFactor * diffractionFactor),
    );

    properties[i] = {
      amplitudeFactor: amplitude,
      directionOffset: dirOffset,
      phaseOffset: phaseOff,
    };
  }

  return properties;
}

// =============================================================================
// Main Builder Entry Point
// =============================================================================

/**
 * Build a terrain-seeded Eulerian wavefront mesh.
 *
 * Phases:
 * 1. Seed vertices from terrain contours + coastline densification + ocean fill
 * 2. Delaunay triangulate the point set
 * 3. Remove land triangles
 * 4. Solve eikonal equation via FMM
 * 5. Derive per-vertex wave properties
 */
export function buildTerrainEulerianMesh(
  waveSource: WaveSource,
  coastlineBounds: MeshBuildBounds | null,
  terrain: TerrainDataForWorker,
  tideHeight: number,
): WavefrontMeshData {
  // Phase 1: Seed vertices
  const {
    vertices: seededVerts,
    boundsMinX,
    boundsMaxX,
    boundsMinY,
    boundsMaxY,
    gridSpacing,
  } = seedVertices(waveSource, coastlineBounds, terrain, tideHeight);

  if (seededVerts.length < 3) {
    // Degenerate case — return empty mesh
    return {
      vertices: new Float32Array(0),
      indices: new Uint32Array(0),
      vertexCount: 0,
      indexCount: 0,
    };
  }

  // Phase 2: Delaunay triangulation
  // Keep all triangles including those over land — land vertices have amplitude 0,
  // so the GPU interpolates smoothly from 0 (land) to positive (water) at boundaries.
  const allTriangles = delaunayTriangulate(seededVerts);

  if (allTriangles.length === 0) {
    return {
      vertices: new Float32Array(0),
      indices: new Uint32Array(0),
      vertexCount: 0,
      indexCount: 0,
    };
  }

  // Phase 3: Build adjacency and run FMM
  const { vertexNeighbors, vertexTriangles } = buildAdjacency(
    seededVerts.length,
    allTriangles,
  );

  const { travelTime, minDot } = fastMarchingMethod(
    seededVerts,
    allTriangles,
    vertexNeighbors,
    vertexTriangles,
    waveSource,
    terrain,
    tideHeight,
  );

  // Phase 4: Derive wave properties
  const properties = deriveWaveProperties(
    seededVerts,
    allTriangles,
    travelTime,
    waveSource,
    terrain,
    tideHeight,
    minDot,
  );

  // Phase 5: Build output arrays
  const boundaryMargin = gridSpacing;
  const vertexCount = seededVerts.length;
  const vertices = new Float32Array(vertexCount * VERTEX_FLOATS);

  for (let i = 0; i < vertexCount; i++) {
    const base = i * VERTEX_FLOATS;
    const v = seededVerts[i];
    vertices[base + 0] = v.x;
    vertices[base + 1] = v.y;
    vertices[base + 2] = properties[i].amplitudeFactor;
    vertices[base + 3] = properties[i].directionOffset;
    vertices[base + 4] = properties[i].phaseOffset;

    // blendWeight: 0.0 at domain boundary (blend to open ocean), 1.0 interior
    const onBoundary =
      v.x <= boundsMinX + boundaryMargin ||
      v.x >= boundsMaxX - boundaryMargin ||
      v.y <= boundsMinY + boundaryMargin ||
      v.y >= boundsMaxY - boundaryMargin;
    vertices[base + 5] = onBoundary ? 0.0 : 1.0;
  }

  const indexCount = allTriangles.length * 3;
  const indices = new Uint32Array(indexCount);
  for (let i = 0; i < allTriangles.length; i++) {
    indices[i * 3 + 0] = allTriangles[i].a;
    indices[i * 3 + 1] = allTriangles[i].b;
    indices[i * 3 + 2] = allTriangles[i].c;
  }

  return {
    vertices,
    indices,
    vertexCount,
    indexCount,
  };
}
