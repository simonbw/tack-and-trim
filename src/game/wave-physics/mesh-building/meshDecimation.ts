/**
 * Post-triangulation vertex decimation.
 *
 * Operates on the final triangle mesh (WavefrontMeshData). Greedily removes
 * interior vertices whose signal fields (amp·cos(phase), amp·sin(phase),
 * blend weight) can be accurately reconstructed from their neighbours.
 *
 * Uses a multi-pass independent-set approach with flat CSR adjacency rebuilt
 * each pass. After the first pass, only neighbours of removed vertices are
 * reconsidered as candidates, narrowing the work per pass quickly.
 *
 * No engine imports — safe for use in web workers.
 */

import type { WavefrontMeshData } from "./MeshBuildTypes";
import { VERTEX_FLOATS } from "./marchingTypes";

/** Default tolerance for post-triangulation decimation. */
export const DEFAULT_MESH_DECIMATION_TOLERANCE = 0.1;

// Vertex layout: [x, y, amplitude, broken, phaseOffset, interior]
const OFF_X = 0;
const OFF_Y = 1;
const OFF_AMP = 2;
const OFF_PHASE = 4;
const OFF_INTERIOR = 5;

const MAX_FAN = 32;


// Pre-allocated buffers (ring extraction + ear clipping)
const rEdgeA = new Int32Array(MAX_FAN);
const rEdgeB = new Int32Array(MAX_FAN);
const rUsed = new Uint8Array(MAX_FAN);
const rOut = new Int32Array(MAX_FAN * 2);
const eTri = new Int32Array(MAX_FAN * 3);
const ePoly = new Int32Array(MAX_FAN);

// ---------------------------------------------------------------------------
// Ring extraction
// ---------------------------------------------------------------------------

function extractRing(
  v: number,
  adjOff: number,
  adjEnd: number,
  adjData: Uint32Array,
  indices: Uint32Array,
): number {
  let n = 0;
  for (let i = adjOff; i < adjEnd; i++) {
    if (n >= MAX_FAN) return 0;
    const base = adjData[i] * 3;
    const a = indices[base],
      b = indices[base + 1],
      c = indices[base + 2];
    if (a === v) {
      rEdgeA[n] = b;
      rEdgeB[n] = c;
    } else if (b === v) {
      rEdgeA[n] = a;
      rEdgeB[n] = c;
    } else {
      rEdgeA[n] = a;
      rEdgeB[n] = b;
    }
    n++;
  }
  if (n < 3) return 0;

  rOut[0] = rEdgeA[0];
  rOut[1] = rEdgeB[0];
  rUsed.fill(0, 0, n);
  rUsed[0] = 1;
  let len = 2;

  for (let step = 1; step < n; step++) {
    const last = rOut[len - 1];
    let found = false;
    for (let j = 0; j < n; j++) {
      if (rUsed[j]) continue;
      if (rEdgeA[j] === last) {
        rOut[len++] = rEdgeB[j];
        rUsed[j] = 1;
        found = true;
        break;
      }
      if (rEdgeB[j] === last) {
        rOut[len++] = rEdgeA[j];
        rUsed[j] = 1;
        found = true;
        break;
      }
    }
    if (!found) return 0;
  }

  if (rOut[len - 1] === rOut[0]) {
    len--;
  } else {
    const first = rOut[0],
      last = rOut[len - 1];
    let closes = false;
    for (let j = 0; j < n; j++) {
      if (
        (rEdgeA[j] === first && rEdgeB[j] === last) ||
        (rEdgeA[j] === last && rEdgeB[j] === first)
      ) {
        closes = true;
        break;
      }
    }
    if (!closes) return 0;
  }

  return len < 3 ? 0 : len;
}

// ---------------------------------------------------------------------------
// Ring simplicity check — reject self-intersecting ring polygons
// ---------------------------------------------------------------------------

function isSimpleRing(
  ringLen: number,
  xs: Float32Array,
  ys: Float32Array,
): boolean {
  // Check every pair of non-adjacent edges for intersection
  for (let i = 0; i < ringLen; i++) {
    const i2 = (i + 1) % ringLen;
    const ax = xs[rOut[i]],
      ay = ys[rOut[i]];
    const bx = xs[rOut[i2]],
      by = ys[rOut[i2]];

    for (let j = i + 2; j < ringLen; j++) {
      if (i === 0 && j === ringLen - 1) continue; // adjacent (wraps around)
      const j2 = (j + 1) % ringLen;
      const cx = xs[rOut[j]],
        cy = ys[rOut[j]];
      const dx = xs[rOut[j2]],
        dy = ys[rOut[j2]];

      // Check if segment (a,b) intersects segment (c,d)
      const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
      const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
      const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);

      if (d1 * d2 < 0 && d3 * d4 < 0) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Ear clipping — writes into eTri[i*3..i*3+2]
// ---------------------------------------------------------------------------

function earClip(
  ringLen: number,
  xs: Float32Array,
  ys: Float32Array,
): number {
  let tc = 0;
  if (ringLen < 3) return 0;

  let pLen = ringLen;
  for (let i = 0; i < pLen; i++) ePoly[i] = rOut[i];

  let area2 = 0;
  for (let i = 0; i < pLen; i++) {
    const j = (i + 1) % pLen;
    area2 += xs[ePoly[i]] * ys[ePoly[j]] - xs[ePoly[j]] * ys[ePoly[i]];
  }
  const ws = area2 >= 0 ? 1 : -1;

  let safety = pLen * pLen;
  while (pLen > 3 && safety-- > 0) {
    let earFound = false;
    for (let i = 0; i < pLen; i++) {
      const pi = (i + pLen - 1) % pLen;
      const ni = (i + 1) % pLen;
      const a = ePoly[pi],
        b = ePoly[i],
        c = ePoly[ni];
      const ax = xs[a],
        ay = ys[a],
        bx = xs[b],
        by = ys[b],
        cx = xs[c],
        cy = ys[c];

      if (((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) * ws < 0) continue;

      let ins = false;
      for (let j = 0; j < pLen; j++) {
        if (j === pi || j === i || j === ni) continue;
        const px = xs[ePoly[j]],
          py = ys[ePoly[j]];
        const d1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
        const d2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
        const d3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
        if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) {
          ins = true;
          break;
        }
      }
      if (ins) continue;

      eTri[tc * 3] = a;
      eTri[tc * 3 + 1] = b;
      eTri[tc * 3 + 2] = c;
      tc++;

      for (let k = i; k < pLen - 1; k++) ePoly[k] = ePoly[k + 1];
      pLen--;
      earFound = true;
      break;
    }
    if (!earFound) break;
  }

  if (pLen === 3) {
    eTri[tc * 3] = ePoly[0];
    eTri[tc * 3 + 1] = ePoly[1];
    eTri[tc * 3 + 2] = ePoly[2];
    tc++;
  }

  return tc;
}

// ---------------------------------------------------------------------------
// Error computation (fan triangulation of ring)
// ---------------------------------------------------------------------------

function computeError(
  v: number,
  ringLen: number,
  xs: Float32Array,
  ys: Float32Array,
  sC: Float32Array,
  sS: Float32Array,
  sI: Float32Array,
): number {
  const px = xs[v],
    py = ys[v];
  const aC = sC[v],
    aS = sS[v],
    aI = sI[v];
  const r0 = rOut[0];
  const r0x = xs[r0],
    r0y = ys[r0];

  for (let i = 1; i < ringLen - 1; i++) {
    const a = rOut[i],
      b = rOut[i + 1];
    const v0x = xs[a] - r0x,
      v0y = ys[a] - r0y;
    const v1x = xs[b] - r0x,
      v1y = ys[b] - r0y;
    const v2x = px - r0x,
      v2y = py - r0y;
    const d00 = v0x * v0x + v0y * v0y;
    const d01 = v0x * v1x + v0y * v1y;
    const d11 = v1x * v1x + v1y * v1y;
    const d20 = v2x * v0x + v2y * v0y;
    const d21 = v2x * v1x + v2y * v1y;
    const den = d00 * d11 - d01 * d01;
    if (Math.abs(den) < 1e-12) continue;
    const inv = 1 / den;
    const w1 = (d11 * d20 - d01 * d21) * inv;
    const w2 = (d00 * d21 - d01 * d20) * inv;
    const w0 = 1 - w1 - w2;
    if (w0 < -0.01 || w1 < -0.01 || w2 < -0.01) continue;

    return Math.max(
      Math.abs(aC - (w0 * sC[r0] + w1 * sC[a] + w2 * sC[b])),
      Math.abs(aS - (w0 * sS[r0] + w1 * sS[a] + w2 * sS[b])),
      Math.abs(aI - (w0 * sI[r0] + w1 * sI[a] + w2 * sI[b])),
    );
  }

  return Infinity;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function decimateMesh(
  mesh: WavefrontMeshData,
  tolerance: number = DEFAULT_MESH_DECIMATION_TOLERANCE,
): WavefrontMeshData {
  const t0 = performance.now();

  const { vertices: verts, vertexCount, indexCount } = mesh;
  const origTriCount = (indexCount / 3) | 0;

  // Pre-compute per-vertex signal fields
  const xs = new Float32Array(vertexCount);
  const ys = new Float32Array(vertexCount);
  const sC = new Float32Array(vertexCount);
  const sS = new Float32Array(vertexCount);
  const sI = new Float32Array(vertexCount);
  const isInt = new Uint8Array(vertexCount);

  for (let v = 0; v < vertexCount; v++) {
    const b = v * VERTEX_FLOATS;
    xs[v] = verts[b + OFF_X];
    ys[v] = verts[b + OFF_Y];
    const amp = verts[b + OFF_AMP];
    const phase = verts[b + OFF_PHASE];
    sC[v] = amp * Math.cos(phase);
    sS[v] = amp * Math.sin(phase);
    sI[v] = verts[b + OFF_INTERIOR];
    if (verts[b + OFF_INTERIOR] === 1.0) isInt[v] = 1;
  }

  // Mutable index buffer
  const idx = new Uint32Array(mesh.indices.buffer.slice(0, indexCount * 4));
  const triCount = origTriCount;

  // Dead triangle bitfield (persists across passes)
  const dead = new Uint8Array(triCount);
  const removed = new Uint8Array(vertexCount);
  let totalRemovals = 0;

  // Pre-allocate reusable buffers for adjacency building
  const adjCounts = new Uint32Array(vertexCount);
  const adjOffsets = new Uint32Array(vertexCount + 1);
  const adjData = new Uint32Array(triCount * 3);

  // Reusable marked array
  const marked = new Uint8Array(vertexCount);

  // New triangles buffer (small initial size, grows as needed)
  let newTriBuf = new Uint32Array(65536 * 3);
  let newTriCount = 0;

  // Double-buffered candidate lists to avoid overwrite corruption
  const candidatesA = new Uint32Array(vertexCount);
  const candidatesB = new Uint32Array(vertexCount);
  let curCandidates = candidatesA;
  let nextCandidates = candidatesB;
  let candidateCount = 0;
  for (let v = 0; v < vertexCount; v++) {
    if (isInt[v]) curCandidates[candidateCount++] = v;
  }
  const inCandidates = new Uint8Array(vertexCount);

  const t1 = performance.now();

  let pass = 0;
  while (candidateCount > 0) {
    pass++;

    // Build adjacency (CSR-style, reusing pre-allocated buffers)
    adjCounts.fill(0);
    for (let ti = 0; ti < triCount; ti++) {
      if (dead[ti]) continue;
      const b = ti * 3;
      adjCounts[idx[b]]++;
      adjCounts[idx[b + 1]]++;
      adjCounts[idx[b + 2]]++;
    }
    adjOffsets[0] = 0;
    for (let v = 0; v < vertexCount; v++) {
      adjOffsets[v + 1] = adjOffsets[v] + adjCounts[v];
      adjCounts[v] = 0;
    }
    for (let ti = 0; ti < triCount; ti++) {
      if (dead[ti]) continue;
      const b = ti * 3;
      const a0 = idx[b],
        a1 = idx[b + 1],
        a2 = idx[b + 2];
      adjData[adjOffsets[a0] + adjCounts[a0]++] = ti;
      adjData[adjOffsets[a1] + adjCounts[a1]++] = ti;
      adjData[adjOffsets[a2] + adjCounts[a2]++] = ti;
    }

    // Mark candidates for removal (independent set)
    let removalsThisPass = 0;

    for (let ci = 0; ci < candidateCount; ci++) {
      const v = curCandidates[ci];
      if (removed[v] || !isInt[v]) continue;
      const off = adjOffsets[v],
        end = adjOffsets[v + 1];
      if (end - off < 3) continue;

      // Check no neighbor already marked this pass
      let neighborMarked = false;
      for (let i = off; i < end && !neighborMarked; i++) {
        const tb = adjData[i] * 3;
        for (let k = 0; k < 3; k++) {
          const u = idx[tb + k];
          if (u !== v && marked[u]) {
            neighborMarked = true;
            break;
          }
        }
      }
      if (neighborMarked) continue;

      const ringLen = extractRing(v, off, end, adjData, idx);
      if (ringLen === 0) continue;

      // Reject self-intersecting ring polygons to prevent degenerate triangles
      if (!isSimpleRing(ringLen, xs, ys)) continue;

      const error = computeError(v, ringLen, xs, ys, sC, sS, sI);
      if (error > tolerance) continue;

      marked[v] = 1;
      removalsThisPass++;
    }

    if (removalsThisPass === 0) break;
    totalRemovals += removalsThisPass;

    // Batch removal + collect next-pass candidates (into separate buffer)
    newTriCount = 0;
    let nextCandidateCount = 0;
    inCandidates.fill(0);

    for (let ci = 0; ci < candidateCount; ci++) {
      const v = curCandidates[ci];
      if (!marked[v]) continue;
      marked[v] = 0;
      removed[v] = 1;

      const off = adjOffsets[v],
        end = adjOffsets[v + 1];
      for (let i = off; i < end; i++) dead[adjData[i]] = 1;

      const ringLen = extractRing(v, off, end, adjData, idx);
      if (ringLen === 0) continue;
      const ntc = earClip(ringLen, xs, ys);

      const needed = (newTriCount + ntc) * 3;
      if (needed > newTriBuf.length) {
        const bigger = new Uint32Array(needed * 2);
        bigger.set(newTriBuf.subarray(0, newTriCount * 3));
        newTriBuf = bigger;
      }

      for (let i = 0; i < ntc; i++) {
        const base = newTriCount * 3;
        newTriBuf[base] = eTri[i * 3];
        newTriBuf[base + 1] = eTri[i * 3 + 1];
        newTriBuf[base + 2] = eTri[i * 3 + 2];
        newTriCount++;
      }

      for (let i = 0; i < ringLen; i++) {
        const rv = rOut[i];
        if (!removed[rv] && isInt[rv] && !inCandidates[rv]) {
          inCandidates[rv] = 1;
          nextCandidates[nextCandidateCount++] = rv;
        }
      }
    }

    // Clear marked for non-removed candidates
    for (let ci = 0; ci < candidateCount; ci++) {
      marked[curCandidates[ci]] = 0;
    }

    // Swap candidate buffers
    const tmp = curCandidates;
    curCandidates = nextCandidates;
    nextCandidates = tmp;
    candidateCount = nextCandidateCount;

    // Reuse dead triangle slots for new triangles
    let slotScan = 0;
    let newTriIdx = 0;
    while (newTriIdx < newTriCount) {
      while (slotScan < triCount && !dead[slotScan]) slotScan++;
      if (slotScan >= triCount) break;
      const b = slotScan * 3;
      const ni = newTriIdx * 3;
      idx[b] = newTriBuf[ni];
      idx[b + 1] = newTriBuf[ni + 1];
      idx[b + 2] = newTriBuf[ni + 2];
      dead[slotScan] = 0;
      slotScan++;
      newTriIdx++;
    }
  }

  const t2 = performance.now();

  // Compact
  const remap = new Int32Array(vertexCount).fill(-1);
  let newVertCount = 0;
  for (let v = 0; v < vertexCount; v++) {
    if (!removed[v]) remap[v] = newVertCount++;
  }

  const newVerts = new Float32Array(newVertCount * VERTEX_FLOATS);
  for (let v = 0; v < vertexCount; v++) {
    if (remap[v] < 0) continue;
    const src = v * VERTEX_FLOATS,
      dst = remap[v] * VERTEX_FLOATS;
    for (let k = 0; k < VERTEX_FLOATS; k++) newVerts[dst + k] = verts[src + k];
  }

  let liveTriCount = 0;
  for (let ti = 0; ti < triCount; ti++) {
    if (!dead[ti]) liveTriCount++;
  }
  const finalIdx = new Uint32Array(liveTriCount * 3);
  let fi = 0;
  for (let ti = 0; ti < triCount; ti++) {
    if (dead[ti]) continue;
    const b = ti * 3;
    const a = remap[idx[b]],
      b2 = remap[idx[b + 1]],
      c = remap[idx[b + 2]];
    if (a >= 0 && b2 >= 0 && c >= 0 && a !== b2 && b2 !== c && a !== c) {
      finalIdx[fi++] = a;
      finalIdx[fi++] = b2;
      finalIdx[fi++] = c;
    }
  }
  const finalIdxTrimmed = fi < finalIdx.length ? finalIdx.subarray(0, fi) : finalIdx;

  const t3 = performance.now();
  const finalTriCount = (fi / 3) | 0;

  console.log(
    [
      `[meshDecimation] ${pass} passes`,
      `  ${vertexCount} -> ${newVertCount} verts (${totalRemovals} removed, ${((totalRemovals / vertexCount) * 100).toFixed(1)}%)`,
      `  ${origTriCount} -> ${finalTriCount} tris`,
      `  init: ${(t1 - t0).toFixed(1)}ms`,
      `  removal: ${(t2 - t1).toFixed(1)}ms`,
      `  compact: ${(t3 - t2).toFixed(1)}ms`,
      `  total: ${(t3 - t0).toFixed(1)}ms`,
    ].join("\n"),
  );

  return {
    vertices: newVerts,
    indices: new Uint32Array(finalIdxTrimmed),
    vertexCount: newVertCount,
    indexCount: fi,
    coverageQuad: mesh.coverageQuad,
  };
}
