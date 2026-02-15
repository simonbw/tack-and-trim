/**
 * Post-march wavefront decimation.
 *
 * Removes redundant wavefront rows (steps) and redundant vertices within rows
 * where the mesh varies slowly — typically deep open water far from terrain.
 * Runs after amplitude computation and before triangulation.
 *
 * Key invariant: a node marked for removal is never used as a reference point
 * when evaluating whether other nodes can be removed. Both row decimation and
 * vertex decimation use a greedy forward scan where the "anchor" is always a
 * kept node, and each candidate is checked against interpolation between its
 * nearest surviving (kept) neighbours only.
 */

import type { Wavefront, WavefrontSegment } from "./marchingTypes";

/** Default decimation tolerance — controls the quality/density trade-off. */
export const DEFAULT_DECIMATION_TOLERANCE = 0.02;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lerpScalar(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Performance tracking
let sampleStepAtTCalls = 0;
let rowDecimationEvaluationCalls = 0;
let canRemoveVerticesBetweenCalls = 0;

/**
 * Sample a wavefront step at a given t-value by finding the segment that
 * covers that t and linearly interpolating between the bracketing vertices.
 * Returns null if t falls in a gap between segments.
 */
function sampleStepAtT(
  wavefront: readonly WavefrontSegment[],
  t: number,
): { x: number; y: number; amplitude: number } | null {
  sampleStepAtTCalls++;
  for (const segment of wavefront) {
    if (segment.length === 0) continue;
    const tMin = segment[0].t;
    const tMax = segment[segment.length - 1].t;
    if (t < tMin - 1e-9 || t > tMax + 1e-9) continue;

    // Clamp to segment endpoints
    if (t <= tMin) {
      const p = segment[0];
      return { x: p.x, y: p.y, amplitude: p.amplitude };
    }
    if (t >= tMax) {
      const p = segment[segment.length - 1];
      return { x: p.x, y: p.y, amplitude: p.amplitude };
    }

    // Binary search for the bracketing vertices (segment is sorted by t)
    let left = 0;
    let right = segment.length - 1;
    while (left < right - 1) {
      const mid = Math.floor((left + right) / 2);
      if (segment[mid].t <= t) {
        left = mid;
      } else {
        right = mid;
      }
    }

    // left and right now bracket t
    const a = segment[left];
    const b = segment[right];
    const span = b.t - a.t;
    const f = span > 0 ? (t - a.t) / span : 0;
    return {
      x: lerpScalar(a.x, b.x, f),
      y: lerpScalar(a.y, b.y, f),
      amplitude: lerpScalar(a.amplitude, b.amplitude, f),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Row decimation
// ---------------------------------------------------------------------------

type RowSample = { x: number; y: number; amplitude: number; phase: number };

type RowCandidate = {
  rowIdx: number;
  prevIdx: number;
  nextIdx: number;
  score: number;
};

class RowCandidateHeap {
  private readonly data: RowCandidate[] = [];

  get size(): number {
    return this.data.length;
  }

  push(candidate: RowCandidate): void {
    this.data.push(candidate);
    this.bubbleUp(this.data.length - 1);
  }

  pop(): RowCandidate | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0];
    const tail = this.data.pop();
    if (!tail) return top;
    if (this.data.length > 0) {
      this.data[0] = tail;
      this.bubbleDown(0);
    }
    return top;
  }

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.isHigherPriority(this.data[parent], this.data[index])) break;
      [this.data[parent], this.data[index]] = [
        this.data[index],
        this.data[parent],
      ];
      index = parent;
    }
  }

  private bubbleDown(index: number): void {
    const size = this.data.length;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let best = index;

      if (
        left < size &&
        this.isHigherPriority(this.data[left], this.data[best])
      ) {
        best = left;
      }
      if (
        right < size &&
        this.isHigherPriority(this.data[right], this.data[best])
      ) {
        best = right;
      }
      if (best === index) break;
      [this.data[index], this.data[best]] = [this.data[best], this.data[index]];
      index = best;
    }
  }

  private isHigherPriority(a: RowCandidate, b: RowCandidate): boolean {
    if (a.score !== b.score) return a.score < b.score;
    return a.rowIdx < b.rowIdx;
  }
}

function normalizedError(error: number, tolerance: number): number {
  if (tolerance <= 0) return error === 0 ? 0 : Number.POSITIVE_INFINITY;
  return error / tolerance;
}

/**
 * Evaluate whether a single interior row can be removed by interpolating from
 * its current kept neighbours.
 *
 * Returns:
 * - removable: whether the row is within all tolerances
 * - score: max normalised error (0 best, 1 at threshold), used for ranking
 */
function evaluateRowRemoval(
  wavefronts: readonly Wavefront[],
  rowIdx: number,
  anchorIdx: number,
  endpointIdx: number,
  k: number,
  waveDx: number,
  waveDy: number,
  posTolSq: number,
  ampTol: number,
  phaseTol: number,
  phasePerStep: number,
): { removable: boolean; score: number } {
  rowDecimationEvaluationCalls++;
  const row: Wavefront = wavefronts[rowIdx];
  const anchor: Wavefront = wavefronts[anchorIdx];
  const endpoint: Wavefront = wavefronts[endpointIdx];
  const span = endpointIdx - anchorIdx;
  if (span <= 1) return { removable: false, score: Number.POSITIVE_INFINITY };
  const fraction = (rowIdx - anchorIdx) / span;
  const rowPhaseBase = rowIdx * phasePerStep;
  const anchorPhaseBase = anchorIdx * phasePerStep;
  const endpointPhaseBase = endpointIdx * phasePerStep;
  let maxError = 0;

  // Cache samples from anchor and endpoint rows to avoid repeated linear
  // searches for repeated t-values.
  const anchorCache = new Map<number, RowSample>();
  const endpointCache = new Map<number, RowSample>();

  for (const segment of row) {
    for (const point of segment) {
      // Try cache first, then compute and cache if needed.
      let fromAnchor = anchorCache.get(point.t);
      if (!fromAnchor) {
        const sample = sampleStepAtT(anchor, point.t);
        if (!sample) return { removable: false, score: Number.POSITIVE_INFINITY };
        fromAnchor = {
          ...sample,
          phase: anchorPhaseBase - k * (sample.x * waveDx + sample.y * waveDy),
        };
        anchorCache.set(point.t, fromAnchor);
      }

      let fromEndpoint = endpointCache.get(point.t);
      if (!fromEndpoint) {
        const sample = sampleStepAtT(endpoint, point.t);
        if (!sample) return { removable: false, score: Number.POSITIVE_INFINITY };
        fromEndpoint = {
          ...sample,
          phase: endpointPhaseBase - k * (sample.x * waveDx + sample.y * waveDy),
        };
        endpointCache.set(point.t, fromEndpoint);
      }

      // Position error.
      const ix = lerpScalar(fromAnchor.x, fromEndpoint.x, fraction);
      const iy = lerpScalar(fromAnchor.y, fromEndpoint.y, fraction);
      const dx = point.x - ix;
      const dy = point.y - iy;
      const posErrSq = dx * dx + dy * dy;
      const posScore = normalizedError(posErrSq, posTolSq);
      if (posScore > 1) {
        return { removable: false, score: Number.POSITIVE_INFINITY };
      }
      if (posScore > maxError) maxError = posScore;

      // Amplitude error.
      const iAmp = lerpScalar(
        fromAnchor.amplitude,
        fromEndpoint.amplitude,
        fraction,
      );
      const ampErr = Math.abs(point.amplitude - iAmp);
      const ampScore = normalizedError(ampErr, ampTol);
      if (ampScore > 1) {
        return { removable: false, score: Number.POSITIVE_INFINITY };
      }
      if (ampScore > maxError) maxError = ampScore;

      // Phase-offset error.
      // phaseOffset = stepIndex * phasePerStep − k * dot(position, waveDir)
      const actualPhase = rowPhaseBase - k * (point.x * waveDx + point.y * waveDy);
      const iPhase = lerpScalar(fromAnchor.phase, fromEndpoint.phase, fraction);
      const phaseErr = Math.abs(actualPhase - iPhase);
      const phaseScore = normalizedError(phaseErr, phaseTol);
      if (phaseScore > 1) {
        return { removable: false, score: Number.POSITIVE_INFINITY };
      }
      if (phaseScore > maxError) maxError = phaseScore;
    }
  }
  return { removable: true, score: maxError };
}

/**
 * Iteratively remove one interior row at a time.
 *
 * Candidate rows are scored by max normalised interpolation error versus
 * their current neighbours. We repeatedly remove the lowest-error removable
 * row, then only re-evaluate its adjacent neighbours.
 */
function decimateRows(
  wavefronts: readonly Wavefront[],
  k: number,
  waveDx: number,
  waveDy: number,
  posTolSq: number,
  ampTol: number,
  phaseTol: number,
  phasePerStep: number,
): { wavefronts: Wavefront[]; stepIndices: number[] } {
  const N = wavefronts.length;
  if (N <= 2) {
    return {
      wavefronts: wavefronts.slice(),
      stepIndices: Array.from({ length: N }, (_, i) => i),
    };
  }

  const prev = new Int32Array(N);
  const next = new Int32Array(N);
  const active = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    prev[i] = i - 1;
    next[i] = i + 1;
    active[i] = 1;
  }
  next[N - 1] = -1;

  const heap = new RowCandidateHeap();

  const enqueueIfRemovable = (rowIdx: number): void => {
    if (rowIdx <= 0 || rowIdx >= N - 1) return;
    if (active[rowIdx] === 0) return;
    const prevIdx = prev[rowIdx];
    const nextIdx = next[rowIdx];
    if (prevIdx < 0 || nextIdx < 0) return;

    const evalResult = evaluateRowRemoval(
      wavefronts,
      rowIdx,
      prevIdx,
      nextIdx,
      k,
      waveDx,
      waveDy,
      posTolSq,
      ampTol,
      phaseTol,
      phasePerStep,
    );
    if (!evalResult.removable) return;

    heap.push({
      rowIdx,
      prevIdx,
      nextIdx,
      score: evalResult.score,
    });
  };

  for (let rowIdx = 1; rowIdx < N - 1; rowIdx++) {
    enqueueIfRemovable(rowIdx);
  }

  while (heap.size > 0) {
    const candidate = heap.pop();
    if (!candidate) break;

    const { rowIdx, prevIdx, nextIdx } = candidate;
    if (active[rowIdx] === 0) continue; // already removed by another collapse
    if (prev[rowIdx] !== prevIdx || next[rowIdx] !== nextIdx) continue; // stale

    // Remove this row from the active linked list.
    active[rowIdx] = 0;
    next[prevIdx] = nextIdx;
    prev[nextIdx] = prevIdx;

    // Only adjacent rows are affected by this removal.
    enqueueIfRemovable(prevIdx);
    enqueueIfRemovable(nextIdx);
  }

  const kept: number[] = [];
  let idx = 0;
  while (idx !== -1) {
    kept.push(idx);
    idx = next[idx];
  }

  return {
    wavefronts: kept.map((i) => wavefronts[i]),
    stepIndices: kept,
  };
}

// ---------------------------------------------------------------------------
// Vertex decimation within rows
// ---------------------------------------------------------------------------

/**
 * Check whether all vertices strictly between anchorIdx and endpointIdx in a
 * segment are well-approximated by linear interpolation between the anchor
 * and endpoint vertices (both kept).
 */
function canRemoveVerticesBetween(
  segment: WavefrontSegment,
  anchorIdx: number,
  endpointIdx: number,
  posTolSq: number,
  ampTol: number,
): boolean {
  canRemoveVerticesBetweenCalls++;
  const a = segment[anchorIdx];
  const b = segment[endpointIdx];
  const tSpan = b.t - a.t;

  for (let i = anchorIdx + 1; i < endpointIdx; i++) {
    const p = segment[i];
    const f = tSpan > 0 ? (p.t - a.t) / tSpan : 0;

    const ix = lerpScalar(a.x, b.x, f);
    const iy = lerpScalar(a.y, b.y, f);
    const dx = p.x - ix;
    const dy = p.y - iy;
    if (dx * dx + dy * dy > posTolSq) return false;

    const iAmp = lerpScalar(a.amplitude, b.amplitude, f);
    if (Math.abs(p.amplitude - iAmp) > ampTol) return false;
  }
  return true;
}

/**
 * Remove redundant interior vertices from a single segment using the same
 * greedy forward scan. First and last vertices are always kept.
 */
function decimateSegment(
  segment: WavefrontSegment,
  posTolSq: number,
  ampTol: number,
): WavefrontSegment {
  if (segment.length <= 2) return segment;

  const kept: number[] = [0];
  let anchor = 0;
  let endpoint = 2;

  while (endpoint <= segment.length - 1) {
    const removable = canRemoveVerticesBetween(
      segment,
      anchor,
      endpoint,
      posTolSq,
      ampTol,
    );

    if (removable) {
      if (endpoint === segment.length - 1) {
        kept.push(endpoint);
        break;
      }
      endpoint++;
    } else {
      kept.push(endpoint - 1);
      anchor = endpoint - 1;
      endpoint = anchor + 2;
    }
  }

  if (kept[kept.length - 1] !== segment.length - 1) {
    kept.push(segment.length - 1);
  }

  return kept.map((i) => segment[i]);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decimate wavefronts by removing redundant rows and redundant vertices
 * within rows. Returns the simplified wavefronts plus the original step
 * indices (needed by buildMeshData for correct phase computation).
 *
 * @param tolerance  Normalised error budget. Position tolerance is
 *   `tolerance × wavelength`, amplitude tolerance is `tolerance`, and phase
 *   tolerance is `tolerance × π`. A value of 0.1 works well as a default.
 */
export function decimateWavefronts(
  wavefronts: Wavefront[],
  wavelength: number,
  waveDx: number,
  waveDy: number,
  tolerance: number = DEFAULT_DECIMATION_TOLERANCE,
  phasePerStep?: number,
): {
  wavefronts: Wavefront[];
  stepIndices: number[];
  removedRows: number;
  removedVertices: number;
} {
  const t0 = performance.now();

  // Reset counters
  sampleStepAtTCalls = 0;
  rowDecimationEvaluationCalls = 0;
  canRemoveVerticesBetweenCalls = 0;

  const k = (2 * Math.PI) / wavelength;
  const resolvedPhasePerStep = phasePerStep ?? Math.PI;
  const posTolSq = (tolerance * wavelength) ** 2;
  const ampTol = tolerance;
  const phaseTol = tolerance * Math.PI;

  const verticesBefore = countVertices(wavefronts);
  const rowsBefore = wavefronts.length;

  // Phase 1: remove entire wavefront rows that are well-interpolated
  // by their surviving neighbours.
  const t1 = performance.now();
  const { wavefronts: rowDecimated, stepIndices } = decimateRows(
    wavefronts,
    k,
    waveDx,
    waveDy,
    posTolSq,
    ampTol,
    phaseTol,
    resolvedPhasePerStep,
  );
  const t2 = performance.now();
  const rowDecimationTime = t2 - t1;
  const rowDecimationCalls = rowDecimationEvaluationCalls;
  const sampleCallsPhase1 = sampleStepAtTCalls;

  // Reset for phase 2
  sampleStepAtTCalls = 0;

  // Phase 2: thin out vertices within each surviving row.
  let totalSegments = 0;
  const result = rowDecimated.map((step) => {
    totalSegments += step.length;
    return step.map((segment) => decimateSegment(segment, posTolSq, ampTol));
  });
  const t3 = performance.now();
  const vertexDecimationTime = t3 - t2;
  const vertexDecimationCalls = canRemoveVerticesBetweenCalls;
  const sampleCallsPhase2 = sampleStepAtTCalls;

  const verticesAfter = countVertices(result);
  const totalTime = t3 - t0;

  // Single consolidated log
  console.log(
    `Decimation stats: ${totalTime.toFixed(1)}ms total\n` +
      `  Input: ${rowsBefore} rows, ${verticesBefore} vertices\n` +
      `  Output: ${rowDecimated.length} rows (-${rowsBefore - rowDecimated.length}), ${verticesAfter} vertices (-${verticesBefore - verticesAfter})\n` +
      `  Row decimation: ${rowDecimationTime.toFixed(1)}ms, ${rowDecimationCalls} row evaluations, ${sampleCallsPhase1} sampleStepAtT calls\n` +
      `  Vertex decimation: ${vertexDecimationTime.toFixed(1)}ms, ${totalSegments} segments, ${vertexDecimationCalls} canRemoveVerticesBetween calls, ${sampleCallsPhase2} sampleStepAtT calls`,
  );

  return {
    wavefronts: result,
    stepIndices,
    removedRows: wavefronts.length - rowDecimated.length,
    removedVertices: verticesBefore - verticesAfter,
  };
}

function countVertices(wavefronts: Wavefront[]): number {
  let count = 0;
  for (const step of wavefronts) {
    for (const segment of step) {
      count += segment.length;
    }
  }
  return count;
}
