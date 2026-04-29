/**
 * TypeScript port of the water-query shader math.
 *
 * Mirrors the compute entry point in
 * `src/game/world/water/WaterQueryShader.ts` together with the
 * supporting modules:
 *   - `shaders/gerstner-wave.wgsl.ts` — Gerstner two-pass wave sum
 *   - `shaders/mesh-packed.wgsl.ts`   — wavefront mesh lookup per wave
 *   - `shaders/water-modifiers.wgsl.ts` — wakes, ripples, currents, …
 *   - `shaders/terrain-packed.wgsl.ts` — depth sampling (via terrain DFS)
 *   - `shaders/tide-mesh-packed.wgsl.ts` — tidal flow lookup (see tidal-math.ts)
 *   - `shaders/noise.wgsl.ts` — simplex3D for amplitude modulation
 *
 * Worker-safe: no DOM, no BaseEntity, no imports from outside
 * `src/game/world/`.
 *
 * Scope notes:
 *   - `directionOffsets[i]` is hard-coded to 0 just like in the GPU shader
 *     (see the `WaterQueryShader.ts` inner loop that sets it to 0.0).
 *   - Only finite-difference normals (matches the shader). The shader uses
 *     a single shared `ampMod` across center/offset samples; we do the same.
 */

import { FLOATS_PER_CONTOUR } from "./terrain-math";
import { lookupTidalFlow } from "./tidal-math";
import { simplex3D } from "./wind-math";
import {
  GERSTNER_STEEPNESS,
  WAVE_AMP_MOD_SPATIAL_SCALE,
  WAVE_AMP_MOD_STRENGTH,
  WAVE_AMP_MOD_TIME_SCALE,
} from "../water/WaterConstants";

// Inlined from `wave-physics/WavePhysicsManager.ts` and
// `world/water/WaterResources.ts` — those modules pull in main-thread
// deps (BaseEntity, GPU buffers) that would bloat the worker bundle.
// Must stay in sync with the originals.
const MAX_WAVE_SOURCES = 8;
const FLOATS_PER_MODIFIER = 14;
const MAX_MODIFIERS = 16384;

// ---------------------------------------------------------------------------
// Constants mirrored from the WGSL.
// ---------------------------------------------------------------------------

// From core/graphics/webgpu/Shader.ts getMathConstants():
//   const GRAVITY: f32 = 32.174; // ft/s^2
//   const TWO_PI: f32 = 6.28318530717958647692;
const GRAVITY = 32.174;
const TWO_PI = Math.PI * 2;

// From WaterQueryShader.ts:
//   const NORMAL_SAMPLE_OFFSET: f32 = 1.0;
const NORMAL_SAMPLE_OFFSET = 1.0;

// Wave source stride in the waveData storage buffer (see gerstner-wave.wgsl):
//   let base = i * 8; waveData[base + 0]..[base + 7]
const FLOATS_PER_WAVE = 8;

// Modifier type discriminators (from water-modifiers.wgsl.ts).
const MODIFIER_TYPE_WAKE = 1;
const MODIFIER_TYPE_RIPPLE = 2;
const MODIFIER_TYPE_CURRENT = 3;
// MODIFIER_TYPE_OBSTACLE (4) is a no-op in the shader, we match that.
const MODIFIER_TYPE_FOAM = 5;

// ---------------------------------------------------------------------------
// Packed-terrain layout (mirrors terrain-math.ts and terrain-packed.wgsl).
// The shader calls `computeTerrainHeight(queryPoint, &packedTerrain, …)`.
// We replicate the minimal slow-path from terrain-math.ts inline rather than
// taking a dependency on exported helpers, so terrain-math.ts is untouched.
// ---------------------------------------------------------------------------

const HEADER_VERTICES_OFFSET = 0;
const HEADER_CONTOURS_OFFSET = 1;
const HEADER_CHILDREN_OFFSET = 2;

const CONTOUR_POINT_START = 0;
const CONTOUR_POINT_COUNT = 1;
const CONTOUR_HEIGHT = 2;
const CONTOUR_DEPTH = 4;
const CONTOUR_CHILD_START = 5;
const CONTOUR_CHILD_COUNT = 6;
const CONTOUR_BBOX_MIN_X = 8;
const CONTOUR_BBOX_MIN_Y = 9;
const CONTOUR_BBOX_MAX_X = 10;
const CONTOUR_BBOX_MAX_Y = 11;
const CONTOUR_SKIP_COUNT = 12;

const IDW_MIN_DIST = 0.1;

// ---------------------------------------------------------------------------
// Packed-mesh layout (mirrors mesh-packed.wgsl.ts).
// Global header (16 u32): [0]=numWaveSources, [1..8]=meshOffset[0..7], [9..15]=padding.
// Per-wave mesh header (16 u32):
//   [0] vertexOffset  [1] vertexCount   [2] indexOffset   [3] triangleCount
//   [4] gridOffset    [5] gridCols      [6] gridRows      [7] gridMinX (f32)
//   [8] gridMinY (f32) [9] gridCellWidth (f32) [10] gridCellHeight (f32)
//   [11] gridCosA (f32) [12] gridSinA (f32)  [13..15] padding
// Each vertex is 6 floats: [posX, posY, ampFactor, dirOffset, phaseOffset, blendWeight]
// ---------------------------------------------------------------------------

const MESH_HEADER_MESH_OFFSETS_BASE = 1;

// ---------------------------------------------------------------------------
// Float view caches. The WGSL reads f32 fields via `bitcast<f32>()` from the
// same u32 buffer; we mirror this with a Float32Array view aliased over the
// same ArrayBuffer. We cache per input buffer so the worker avoids
// reallocating on every call.
// ---------------------------------------------------------------------------

let _terrainU32: Uint32Array | null = null;
let _terrainF32: Float32Array | null = null;
function terrainFloatView(packed: Uint32Array): Float32Array {
  if (_terrainU32 !== packed) {
    _terrainU32 = packed;
    _terrainF32 = new Float32Array(
      packed.buffer,
      packed.byteOffset,
      packed.length,
    );
  }
  return _terrainF32!;
}

let _meshU32: Uint32Array | null = null;
let _meshF32: Float32Array | null = null;
function meshFloatView(packed: Uint32Array): Float32Array {
  if (_meshU32 !== packed) {
    _meshU32 = packed;
    _meshF32 = new Float32Array(
      packed.buffer,
      packed.byteOffset,
      packed.length,
    );
  }
  return _meshF32!;
}

// ---------------------------------------------------------------------------
// Module-level scratch buffers (single-threaded worker context).
// ---------------------------------------------------------------------------

// Per-wave energy/phase lookup (one entry per wave source, up to MAX_WAVE_SOURCES).
const _energyFactors = new Float64Array(MAX_WAVE_SOURCES);
const _phaseCorrections = new Float64Array(MAX_WAVE_SOURCES);
// directionOffsets is always zero in the query shader, kept as a reminder:
const _directionOffsets = new Float64Array(MAX_WAVE_SOURCES);

// Gerstner result: [height, velX, velY, dhdt].
const _waveResult = new Float64Array(4);

// Modifier accumulator: [totalHeight, totalVelX, totalVelY, maxTurbulence].
const _modifierResult = new Float64Array(4);
// Per-modifier contribution: [height, velX, velY, turbulence].
const _modifierContrib = new Float64Array(4);

// Mesh lookup result: [phasorCos, phasorSin].
const _meshLookup = new Float64Array(2);

// Barycentric scratch.
const _bary = new Float64Array(3);
const _tidalFlowOut = new Float64Array(2);

// ---------------------------------------------------------------------------
// Terrain height (slow path — bbox + winding + linear IDW, no accel grids).
// Mirrors fn_computeTerrainHeight from terrain.wgsl.ts.
// ---------------------------------------------------------------------------

function contourBase(packed: Uint32Array, contourIndex: number): number {
  return packed[HEADER_CONTOURS_OFFSET] + contourIndex * FLOATS_PER_CONTOUR;
}

function getTerrainVertexX(
  packed: Uint32Array,
  f32View: Float32Array,
  vertexIndex: number,
): number {
  const base = packed[HEADER_VERTICES_OFFSET] + vertexIndex * 2;
  return f32View[base];
}

function getTerrainVertexY(
  packed: Uint32Array,
  f32View: Float32Array,
  vertexIndex: number,
): number {
  const base = packed[HEADER_VERTICES_OFFSET] + vertexIndex * 2;
  return f32View[base + 1];
}

function getTerrainChildIndex(
  packed: Uint32Array,
  childListIndex: number,
): number {
  return packed[packed[HEADER_CHILDREN_OFFSET] + childListIndex];
}

function isInsideContour(
  worldX: number,
  worldY: number,
  contourIndex: number,
  packed: Uint32Array,
  f32View: Float32Array,
): boolean {
  const cBase = contourBase(packed, contourIndex);
  const bboxMinX = f32View[cBase + CONTOUR_BBOX_MIN_X];
  const bboxMinY = f32View[cBase + CONTOUR_BBOX_MIN_Y];
  const bboxMaxX = f32View[cBase + CONTOUR_BBOX_MAX_X];
  const bboxMaxY = f32View[cBase + CONTOUR_BBOX_MAX_Y];
  if (
    worldX < bboxMinX ||
    worldX > bboxMaxX ||
    worldY < bboxMinY ||
    worldY > bboxMaxY ||
    bboxMaxX - bboxMinX <= 0 ||
    bboxMaxY - bboxMinY <= 0
  ) {
    return false;
  }

  const n = packed[cBase + CONTOUR_POINT_COUNT];
  const start = packed[cBase + CONTOUR_POINT_START];
  let windingNumber = 0;
  for (let i = 0; i < n; i++) {
    const ai = start + i;
    const bi = start + ((i + 1) % n);
    const ax = getTerrainVertexX(packed, f32View, ai);
    const ay = getTerrainVertexY(packed, f32View, ai);
    const bx = getTerrainVertexX(packed, f32View, bi);
    const by = getTerrainVertexY(packed, f32View, bi);
    if (ay <= worldY) {
      if (by > worldY) {
        const cross = (bx - ax) * (worldY - ay) - (worldX - ax) * (by - ay);
        if (cross > 0) windingNumber += 1;
      }
    } else {
      if (by <= worldY) {
        const cross = (bx - ax) * (worldY - ay) - (worldX - ax) * (by - ay);
        if (cross < 0) windingNumber -= 1;
      }
    }
  }
  return windingNumber !== 0;
}

function distanceToContourBoundary(
  worldX: number,
  worldY: number,
  contourIndex: number,
  packed: Uint32Array,
  f32View: Float32Array,
): number {
  const cBase = contourBase(packed, contourIndex);
  const n = packed[cBase + CONTOUR_POINT_COUNT];
  const start = packed[cBase + CONTOUR_POINT_START];
  let minDistSq = 1e20;
  for (let i = 0; i < n; i++) {
    const ai = start + i;
    const bi = start + ((i + 1) % n);
    const ax = getTerrainVertexX(packed, f32View, ai);
    const ay = getTerrainVertexY(packed, f32View, ai);
    const bx = getTerrainVertexX(packed, f32View, bi);
    const by = getTerrainVertexY(packed, f32View, bi);
    const abx = bx - ax;
    const aby = by - ay;
    const lengthSq = abx * abx + aby * aby;
    let dx: number;
    let dy: number;
    if (lengthSq === 0) {
      dx = worldX - ax;
      dy = worldY - ay;
    } else {
      let t = ((worldX - ax) * abx + (worldY - ay) * aby) / lengthSq;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      dx = worldX - (ax + t * abx);
      dy = worldY - (ay + t * aby);
    }
    const distSq = dx * dx + dy * dy;
    if (distSq < minDistSq) minDistSq = distSq;
  }
  return Math.sqrt(minDistSq);
}

function findDeepestContainingContour(
  worldX: number,
  worldY: number,
  packed: Uint32Array,
  f32View: Float32Array,
  contourCount: number,
): number {
  let deepestIndex = -1;
  let deepestDepth = 0;
  let i = 0;
  let lastToCheck = contourCount;
  while (i < lastToCheck) {
    const cBase = contourBase(packed, i);
    const skipCount = packed[cBase + CONTOUR_SKIP_COUNT];
    if (isInsideContour(worldX, worldY, i, packed, f32View)) {
      const depth = packed[cBase + CONTOUR_DEPTH];
      if (depth >= deepestDepth) {
        deepestDepth = depth;
        deepestIndex = i;
      }
      lastToCheck = i + skipCount + 1;
      i += 1;
    } else {
      i += skipCount + 1;
    }
  }
  return deepestIndex;
}

function computeTerrainHeight(
  worldX: number,
  worldY: number,
  packed: Uint32Array,
  f32View: Float32Array,
  contourCount: number,
  defaultDepth: number,
): number {
  if (contourCount <= 0 || packed.length === 0) return defaultDepth;
  const deepestIndex = findDeepestContainingContour(
    worldX,
    worldY,
    packed,
    f32View,
    contourCount,
  );
  if (deepestIndex < 0) return defaultDepth;

  const parentBase = contourBase(packed, deepestIndex);
  const parentHeight = f32View[parentBase + CONTOUR_HEIGHT];
  const childCount = packed[parentBase + CONTOUR_CHILD_COUNT];
  if (childCount === 0) return parentHeight;

  const distToParent = distanceToContourBoundary(
    worldX,
    worldY,
    deepestIndex,
    packed,
    f32View,
  );
  const parentWeight =
    1.0 / (distToParent < IDW_MIN_DIST ? IDW_MIN_DIST : distToParent);
  let totalWeight = parentWeight;
  let weightedSum = parentHeight * parentWeight;

  const childStart = packed[parentBase + CONTOUR_CHILD_START];
  for (let c = 0; c < childCount; c++) {
    const childIndex = getTerrainChildIndex(packed, childStart + c);
    const childBase = contourBase(packed, childIndex);
    const childHeight = f32View[childBase + CONTOUR_HEIGHT];
    const distToChild = distanceToContourBoundary(
      worldX,
      worldY,
      childIndex,
      packed,
      f32View,
    );
    const childWeight =
      1.0 / (distToChild < IDW_MIN_DIST ? IDW_MIN_DIST : distToChild);
    totalWeight += childWeight;
    weightedSum += childHeight * childWeight;
  }
  return weightedSum / totalWeight;
}

// ---------------------------------------------------------------------------
// Wavefront mesh lookup — ports `lookupMeshForWave` in mesh-packed.wgsl.ts.
// Writes [phasorCos, phasorSin] into _meshLookup.
// ---------------------------------------------------------------------------

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
  // let v0 = b - a; let v1 = c - a; let v2 = p - a;
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

function lookupMeshForWave(
  worldX: number,
  worldY: number,
  packed: Uint32Array,
  f32View: Float32Array,
  waveIndex: number,
): void {
  // Default open-ocean response: phasorCos=1, phasorSin=0 (amplitude=1, phase=0).
  _meshLookup[0] = 0;
  _meshLookup[1] = 0;

  if (packed.length === 0) {
    _meshLookup[0] = 1;
    return;
  }

  // let numWaves = getMeshNumWaves(packed);
  const numWaves = packed[0];
  if (waveIndex >= numWaves) {
    _meshLookup[0] = 1;
    return;
  }

  // let header = getMeshHeader(packed, waveIndex);
  const headerOffset = packed[MESH_HEADER_MESH_OFFSETS_BASE + waveIndex];
  const vertexOffset = packed[headerOffset + 0];
  const indexOffset = packed[headerOffset + 2];
  const triangleCount = packed[headerOffset + 3];
  const gridOffset = packed[headerOffset + 4];
  const gridCols = packed[headerOffset + 5];
  const gridRows = packed[headerOffset + 6];
  const gridMinX = f32View[headerOffset + 7];
  const gridMinY = f32View[headerOffset + 8];
  const gridCellWidth = f32View[headerOffset + 9];
  const gridCellHeight = f32View[headerOffset + 10];
  const gridCosA = f32View[headerOffset + 11];
  const gridSinA = f32View[headerOffset + 12];

  if (triangleCount === 0) {
    _meshLookup[0] = 1;
    return;
  }

  // Rotate world position into wave-aligned grid space.
  //   let rx = worldPos.x * gridCosA + worldPos.y * gridSinA;
  //   let ry = -worldPos.x * gridSinA + worldPos.y * gridCosA;
  const rx = worldX * gridCosA + worldY * gridSinA;
  const ry = -worldX * gridSinA + worldY * gridCosA;
  const gx = (rx - gridMinX) / gridCellWidth;
  const gy = (ry - gridMinY) / gridCellHeight;
  const col = Math.floor(gx);
  const row = Math.floor(gy);

  // Out of grid bounds → open ocean.
  if (col < 0 || col >= gridCols || row < 0 || row >= gridRows) {
    _meshLookup[0] = 1;
    return;
  }

  const cellIndex = row * gridCols + col;
  const cellBase = gridOffset + cellIndex * 2;
  const triListOffset = packed[cellBase];
  const triListCount = packed[cellBase + 1];

  // Iterate ALL triangles in this cell, accumulating phasor contributions.
  let phasorCos = 0;
  let phasorSin = 0;
  for (let t = 0; t < triListCount; t++) {
    const triIndex = packed[triListOffset + t];
    const triBase = indexOffset + triIndex * 3;
    const ai = packed[triBase];
    const bi = packed[triBase + 1];
    const ci = packed[triBase + 2];

    const aBase = vertexOffset + ai * 6;
    const bBase = vertexOffset + bi * 6;
    const cBase = vertexOffset + ci * 6;
    const ax = f32View[aBase];
    const ay = f32View[aBase + 1];
    const bx = f32View[bBase];
    const by = f32View[bBase + 1];
    const cx = f32View[cBase];
    const cy = f32View[cBase + 1];

    barycentric(worldX, worldY, ax, ay, bx, by, cx, cy);
    if (_bary[0] >= -0.001 && _bary[1] >= -0.001 && _bary[2] >= -0.001) {
      // attribA.x = amplitudeFactor, attribA.z = phaseOffset (see vertex layout).
      const aAmp = f32View[aBase + 2];
      const aPhase = f32View[aBase + 4];
      const bAmp = f32View[bBase + 2];
      const bPhase = f32View[bBase + 4];
      const cAmp = f32View[cBase + 2];
      const cPhase = f32View[cBase + 4];

      const amp = aAmp * _bary[0] + bAmp * _bary[1] + cAmp * _bary[2];
      const phase = aPhase * _bary[0] + bPhase * _bary[1] + cPhase * _bary[2];
      phasorCos += amp * Math.cos(phase);
      phasorSin += amp * Math.sin(phase);
    }
  }

  _meshLookup[0] = phasorCos;
  _meshLookup[1] = phasorSin;
  // Inside grid but no containing triangle → shadow (both remain 0).
}

// ---------------------------------------------------------------------------
// Gerstner wave sum — ports `calculateGerstnerWaves` in gerstner-wave.wgsl.
// Writes [height, velX, velY, dhdt] into out.
// ---------------------------------------------------------------------------

function calculateGerstnerWaves(
  worldX: number,
  worldY: number,
  time: number,
  waveData: Float32Array,
  numWaves: number,
  steepness: number,
  energyFactors: Float64Array,
  directionOffsets: Float64Array,
  phaseCorrections: Float64Array,
  ampMod: number,
  out: Float64Array,
): void {
  // First pass: compute Gerstner horizontal displacement.
  let dispX = 0;
  let dispY = 0;

  for (let i = 0; i < numWaves; i++) {
    const base = i * FLOATS_PER_WAVE;
    const amplitude = waveData[base + 0];
    const wavelength = waveData[base + 1];
    const direction = waveData[base + 2];
    const phaseOffset = waveData[base + 3];
    const speedMult = waveData[base + 4];
    const sourceDist = waveData[base + 5];
    const sourceOffsetX = waveData[base + 6];
    const sourceOffsetY = waveData[base + 7];

    const k = TWO_PI / wavelength;
    const omega = Math.sqrt(GRAVITY * k) * speedMult;

    let dx: number;
    let dy: number;
    let phase: number;

    if (sourceDist > 1e9) {
      // Plane wave — apply direction offset for direction bending.
      const bentDirection = direction + directionOffsets[i];
      dx = Math.cos(bentDirection);
      dy = Math.sin(bentDirection);
      const projected = worldX * dx + worldY * dy;
      phase = k * projected - omega * time + phaseOffset + phaseCorrections[i];
    } else {
      // Point source — direction from geometry.
      const baseDx = Math.cos(direction);
      const baseDy = Math.sin(direction);
      const sourceX = -baseDx * sourceDist + sourceOffsetX;
      const sourceY = -baseDy * sourceDist + sourceOffsetY;
      const toPointX = worldX - sourceX;
      const toPointY = worldY - sourceY;
      const distFromSource = Math.sqrt(
        toPointX * toPointX + toPointY * toPointY,
      );
      dx = toPointX / distFromSource;
      dy = toPointY / distFromSource;
      phase =
        k * distFromSource - omega * time + phaseOffset + phaseCorrections[i];
    }

    // let Q = steepness / (k * amplitude * numWaves);
    const Q = steepness / (k * amplitude * numWaves);
    const cosPhase = Math.cos(phase);
    dispX += Q * amplitude * dx * cosPhase;
    dispY += Q * amplitude * dy * cosPhase;
  }

  // Second pass: height, dh/dt, horizontal orbital velocity at displaced sample.
  const sampleX = worldX - dispX;
  const sampleY = worldY - dispY;
  let height = 0;
  let dhdt = 0;
  let velX = 0;
  let velY = 0;

  for (let i = 0; i < numWaves; i++) {
    const base = i * FLOATS_PER_WAVE;
    let amplitude = waveData[base + 0];
    const wavelength = waveData[base + 1];
    const direction = waveData[base + 2];
    const phaseOffset = waveData[base + 3];
    const speedMult = waveData[base + 4];
    const sourceDist = waveData[base + 5];
    const sourceOffsetX = waveData[base + 6];
    const sourceOffsetY = waveData[base + 7];

    // Apply per-wave energy factor.
    amplitude *= energyFactors[i];

    const k = TWO_PI / wavelength;
    const omega = Math.sqrt(GRAVITY * k) * speedMult;

    let phase: number;
    let propDx: number;
    let propDy: number;

    if (sourceDist > 1e9) {
      const bentDirection = direction + directionOffsets[i];
      propDx = Math.cos(bentDirection);
      propDy = Math.sin(bentDirection);
      const projected = sampleX * propDx + sampleY * propDy;
      phase = k * projected - omega * time + phaseOffset + phaseCorrections[i];
    } else {
      const baseDx = Math.cos(direction);
      const baseDy = Math.sin(direction);
      const sourceX = -baseDx * sourceDist + sourceOffsetX;
      const sourceY = -baseDy * sourceDist + sourceOffsetY;
      const toPointX = sampleX - sourceX;
      const toPointY = sampleY - sourceY;
      const distFromSource = Math.sqrt(
        toPointX * toPointX + toPointY * toPointY,
      );
      // let invDist = select(0.0, 1.0 / d, d > 1e-4);
      const invDist = distFromSource > 1e-4 ? 1.0 / distFromSource : 0.0;
      propDx = toPointX * invDist;
      propDy = toPointY * invDist;
      phase =
        k * distFromSource - omega * time + phaseOffset + phaseCorrections[i];
    }

    const sinPhase = Math.sin(phase);
    const cosPhase = Math.cos(phase);

    height += amplitude * ampMod * sinPhase;
    dhdt += -amplitude * ampMod * omega * cosPhase;

    // Orbital velocity coefficient — see WGSL comment: velCoeff depends only
    // on wavenumber, steepness, and omega; scaled by ampMod & energyFactor.
    const velCoeff =
      (steepness / (k * numWaves)) *
      omega *
      ampMod *
      energyFactors[i] *
      sinPhase;
    velX += velCoeff * propDx;
    velY += velCoeff * propDy;
  }

  out[0] = height;
  out[1] = velX;
  out[2] = velY;
  out[3] = dhdt;
}

// ---------------------------------------------------------------------------
// Water modifiers — ports `calculateModifiers` in water-modifiers.wgsl.ts.
// Writes [totalHeight, totalVelX, totalVelY, maxTurbulence] into out.
// ---------------------------------------------------------------------------

function computeWakeContribution(
  worldX: number,
  worldY: number,
  base: number,
  modifiers: Float32Array,
  out: Float64Array,
): void {
  const srcX = modifiers[base + 5];
  const srcY = modifiers[base + 6];
  const ringRadius = modifiers[base + 7];
  const ringWidth = modifiers[base + 8];
  const amplitude = modifiers[base + 9];
  const omega = modifiers[base + 10];

  const dx = worldX - srcX;
  const dy = worldY - srcY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const distFromRing = dist - ringRadius;
  // Gaussian ring profile.
  const ring = Math.exp(
    -(distFromRing * distFromRing) / (ringWidth * ringWidth),
  );
  const localAmp = amplitude * ring;

  const invDist = dist > 1e-4 ? 1 / dist : 0;
  const nx = dx * invDist;
  const ny = dy * invDist;
  const vRadial = localAmp * omega;

  out[0] = localAmp;
  out[1] = vRadial * nx;
  out[2] = vRadial * ny;
  out[3] = 0;
}

function computeRippleContribution(
  worldX: number,
  worldY: number,
  base: number,
  modifiers: Float32Array,
  out: Float64Array,
): void {
  const radius = modifiers[base + 5];
  const intensity = modifiers[base + 6];
  const phase = modifiers[base + 7];

  const minX = modifiers[base + 1];
  const minY = modifiers[base + 2];
  const maxX = modifiers[base + 3];
  const maxY = modifiers[base + 4];
  const centerX = (minX + maxX) * 0.5;
  const centerY = (minY + maxY) * 0.5;
  const dx = worldX - centerX;
  const dy = worldY - centerY;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // 2ft ring width
  const ringWidth = 2.0;
  const distFromRing = Math.abs(dist - radius);
  const falloff = Math.max(0, 1 - distFromRing / ringWidth);

  const height = intensity * falloff * Math.cos(phase);
  out[0] = height;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
}

function computeCurrentContribution(
  _worldX: number,
  _worldY: number,
  base: number,
  modifiers: Float32Array,
  out: Float64Array,
): void {
  const velocityX = modifiers[base + 5];
  const velocityY = modifiers[base + 6];
  // fadeDistance at [base + 7] is unused in the GPU shader ("Simple constant velocity for now").
  out[0] = 0;
  out[1] = velocityX;
  out[2] = velocityY;
  out[3] = 0;
}

function computeFoamContribution(
  worldX: number,
  worldY: number,
  base: number,
  modifiers: Float32Array,
  out: Float64Array,
): void {
  const srcX = modifiers[base + 5];
  const srcY = modifiers[base + 6];
  const radius = modifiers[base + 7];
  const intensity = modifiers[base + 8];

  const dx = worldX - srcX;
  const dy = worldY - srcY;
  const dist2 = dx * dx + dy * dy;
  const rSq = Math.max(radius * radius, 1e-4);
  const falloff = Math.exp(-dist2 / rSq);

  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  out[3] = intensity * falloff;
}

function calculateModifiers(
  worldX: number,
  worldY: number,
  modifiers: Float32Array,
  modifierCount: number,
  out: Float64Array,
): void {
  let totalHeight = 0;
  let totalVelX = 0;
  let totalVelY = 0;
  let maxTurb = 0;

  const count = Math.min(modifierCount, MAX_MODIFIERS);
  for (let i = 0; i < count; i++) {
    const base = i * FLOATS_PER_MODIFIER;
    // Header: type + AABB bounds.
    const modType = modifiers[base + 0] | 0;
    const minX = modifiers[base + 1];
    const minY = modifiers[base + 2];
    const maxX = modifiers[base + 3];
    const maxY = modifiers[base + 4];

    // Bounds culling (early exit) — matches fn_getModifierContribution.
    if (worldX < minX || worldX > maxX || worldY < minY || worldY > maxY) {
      continue;
    }

    switch (modType) {
      case MODIFIER_TYPE_WAKE:
        computeWakeContribution(
          worldX,
          worldY,
          base,
          modifiers,
          _modifierContrib,
        );
        break;
      case MODIFIER_TYPE_RIPPLE:
        computeRippleContribution(
          worldX,
          worldY,
          base,
          modifiers,
          _modifierContrib,
        );
        break;
      case MODIFIER_TYPE_CURRENT:
        computeCurrentContribution(
          worldX,
          worldY,
          base,
          modifiers,
          _modifierContrib,
        );
        break;
      case MODIFIER_TYPE_FOAM:
        computeFoamContribution(
          worldX,
          worldY,
          base,
          modifiers,
          _modifierContrib,
        );
        break;
      default:
        // MODIFIER_TYPE_OBSTACLE (4) and unknown types contribute zero.
        _modifierContrib[0] = 0;
        _modifierContrib[1] = 0;
        _modifierContrib[2] = 0;
        _modifierContrib[3] = 0;
        break;
    }

    totalHeight += _modifierContrib[0];
    totalVelX += _modifierContrib[1];
    totalVelY += _modifierContrib[2];
    if (_modifierContrib[3] > maxTurb) maxTurb = _modifierContrib[3];
  }

  out[0] = totalHeight;
  out[1] = totalVelX;
  out[2] = totalVelY;
  out[3] = maxTurb;
}

// ---------------------------------------------------------------------------
// Height-only helper for finite-difference normals.
// Mirrors `computeWaveResultAtPoint(...).x` in WaterQueryShader.ts.
// Takes the already-populated per-wave energy/phase arrays as input.
// ---------------------------------------------------------------------------

function computeWaveHeight(
  worldX: number,
  worldY: number,
  time: number,
  waveSources: Float32Array,
  numWaves: number,
  ampMod: number,
  tideHeight: number,
): number {
  calculateGerstnerWaves(
    worldX,
    worldY,
    time,
    waveSources,
    numWaves,
    GERSTNER_STEEPNESS,
    _energyFactors,
    _directionOffsets,
    _phaseCorrections,
    ampMod,
    _waveResult,
  );
  return _waveResult[0] + tideHeight;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Port of the water query compute shader main body.
 *
 * Layout matches WaterResultLayout: [surfaceHeight, velocityX, velocityY, normalX, normalY, depth].
 */
export function writeWaterResult(
  worldX: number,
  worldY: number,
  time: number,
  tideHeight: number,
  defaultDepth: number,
  numWaves: number,
  tidalPhase: number,
  tidalStrength: number,
  waveAmplitudeScale: number,
  packedTerrain: Uint32Array,
  packedWaveMesh: Uint32Array,
  packedTideMesh: Uint32Array,
  modifiers: Float32Array,
  modifierCount: number,
  waveSources: Float32Array,
  results: Float32Array,
  resultOffset: number,
): void {
  const terrainF32 = terrainFloatView(packedTerrain);
  const meshF32 = meshFloatView(packedWaveMesh);

  // Derive contour count from the packed-terrain layout: the contour section
  // starts at HEADER_CONTOURS_OFFSET and each contour is FLOATS_PER_CONTOUR
  // wide. The children section follows it, so we derive the count from that.
  // NB: this matches how WaterQueryShader supplies `params.contourCount`.
  let contourCount = 0;
  if (packedTerrain.length > HEADER_CHILDREN_OFFSET) {
    const contoursOffset = packedTerrain[HEADER_CONTOURS_OFFSET];
    const childrenOffset = packedTerrain[HEADER_CHILDREN_OFFSET];
    if (childrenOffset > contoursOffset) {
      contourCount = Math.floor(
        (childrenOffset - contoursOffset) / FLOATS_PER_CONTOUR,
      );
    }
  }

  // Terrain height (depth reference).
  const terrainHeight = computeTerrainHeight(
    worldX,
    worldY,
    packedTerrain,
    terrainF32,
    contourCount,
    defaultDepth,
  );

  // Amplitude modulation noise (shared across center/offset normal samples,
  // per WaterQueryShader.ts where `ampMod` is passed through unchanged).
  //   let ampModTime = time * WAVE_AMP_MOD_TIME_SCALE;
  //   let ampMod = 1 + simplex3D(x*S, y*S, t) * WAVE_AMP_MOD_STRENGTH;
  const ampModTime = time * WAVE_AMP_MOD_TIME_SCALE;
  const ampMod =
    (1.0 +
      simplex3D(
        worldX * WAVE_AMP_MOD_SPATIAL_SCALE,
        worldY * WAVE_AMP_MOD_SPATIAL_SCALE,
        ampModTime,
      ) *
        WAVE_AMP_MOD_STRENGTH) *
    waveAmplitudeScale;

  // Populate per-wave energy/phase arrays from the wavefront mesh.
  // Matches WaterQueryShader.ts inner loop:
  //   energyFactors[i] = sqrt(pc*pc + ps*ps);
  //   directionOffsets[i] = 0;
  //   phaseCorrections[i] = (pc == 0 && ps == 0) ? 0 : atan2(ps, pc);
  const clampedNumWaves = Math.min(numWaves, MAX_WAVE_SOURCES);
  for (let i = 0; i < clampedNumWaves; i++) {
    lookupMeshForWave(worldX, worldY, packedWaveMesh, meshF32, i);
    const pc = _meshLookup[0];
    const ps = _meshLookup[1];
    _energyFactors[i] = Math.sqrt(pc * pc + ps * ps);
    _directionOffsets[i] = 0;
    _phaseCorrections[i] = pc === 0 && ps === 0 ? 0 : Math.atan2(ps, pc);
  }
  // Zero out unused entries so dangling stale data can't leak in.
  for (let i = clampedNumWaves; i < MAX_WAVE_SOURCES; i++) {
    _energyFactors[i] = 0;
    _directionOffsets[i] = 0;
    _phaseCorrections[i] = 0;
  }

  // Primary Gerstner evaluation.
  calculateGerstnerWaves(
    worldX,
    worldY,
    time,
    waveSources,
    clampedNumWaves,
    GERSTNER_STEEPNESS,
    _energyFactors,
    _directionOffsets,
    _phaseCorrections,
    ampMod,
    _waveResult,
  );
  const waveHeight = _waveResult[0] + tideHeight;
  const waveVelX = _waveResult[1];
  const waveVelY = _waveResult[2];

  // Finite-difference normal — matches WaterQueryShader.ts computeNormal:
  //   let dx = (hx - h0) / NORMAL_SAMPLE_OFFSET;
  //   let dy = (hy - h0) / NORMAL_SAMPLE_OFFSET;
  //   if (|grad|^2 < 1e-4) return (0, 0);
  //   else return normalize(-dx, -dy).
  // We re-use the populated _energyFactors/_phaseCorrections for all 3
  // samples (they depend on position, but the GPU shader does the same —
  // see comment at top of file).
  const h0 = waveHeight;
  const hx = computeWaveHeight(
    worldX + NORMAL_SAMPLE_OFFSET,
    worldY,
    time,
    waveSources,
    clampedNumWaves,
    ampMod,
    tideHeight,
  );
  const hy = computeWaveHeight(
    worldX,
    worldY + NORMAL_SAMPLE_OFFSET,
    time,
    waveSources,
    clampedNumWaves,
    ampMod,
    tideHeight,
  );
  const ndx = (hx - h0) / NORMAL_SAMPLE_OFFSET;
  const ndy = (hy - h0) / NORMAL_SAMPLE_OFFSET;

  let normalX = 0;
  let normalY = 0;
  const gradientLen = ndx * ndx + ndy * ndy;
  if (gradientLen >= 0.0001) {
    const invLen = 1 / Math.sqrt(gradientLen);
    normalX = -ndx * invLen;
    normalY = -ndy * invLen;
  }

  // Modifier contributions (wakes, ripples, currents, obstacles).
  calculateModifiers(worldX, worldY, modifiers, modifierCount, _modifierResult);

  // Final surface height + depth.
  const finalSurfaceHeight = waveHeight + _modifierResult[0];
  const finalDepth = finalSurfaceHeight - terrainHeight;

  // Tidal flow velocity — port of `lookupTidalFlow` from
  // `tide-mesh-packed.wgsl.ts`. Returns (0, 0) when the tide mesh is
  // empty (placeholder buffer) or the point falls outside the mesh.
  lookupTidalFlow(
    worldX,
    worldY,
    packedTideMesh,
    tideHeight,
    tidalPhase,
    tidalStrength,
    _tidalFlowOut,
  );
  const tidalVelX = _tidalFlowOut[0];
  const tidalVelY = _tidalFlowOut[1];

  results[resultOffset + 0] = finalSurfaceHeight;
  results[resultOffset + 1] = waveVelX + _modifierResult[1] + tidalVelX;
  results[resultOffset + 2] = waveVelY + _modifierResult[2] + tidalVelY;
  results[resultOffset + 3] = normalX;
  results[resultOffset + 4] = normalY;
  results[resultOffset + 5] = finalDepth;
}
