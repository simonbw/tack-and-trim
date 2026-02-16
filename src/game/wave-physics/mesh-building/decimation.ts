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
const LOG_DECIMATION_STATS = false;
let sampleStepAtTCalls = 0;
let rowDecimationEvaluationCalls = 0;
let canRemoveVerticesBetweenCalls = 0;

/**
 * Sample a wavefront step at a given t-value by finding the segment that
 * covers that t and linearly interpolating between the bracketing vertices.
 * Returns null if t falls in a gap between segments.
 */
type StepSample = { x: number; y: number; amplitude: number };

function sampleStepAtT(
  wavefront: readonly WavefrontSegment[],
  t: number,
  out: StepSample,
): boolean {
  if (LOG_DECIMATION_STATS) sampleStepAtTCalls++;
  for (const segment of wavefront) {
    const segT = segment.t;
    const len = segT.length;
    if (len === 0) continue;

    const tMin = segT[0];
    const tMax = segT[len - 1];
    if (t < tMin - 1e-9 || t > tMax + 1e-9) continue;

    const segX = segment.x;
    const segY = segment.y;
    const segAmp = segment.amplitude;

    // Clamp to segment endpoints
    if (t <= tMin) {
      out.x = segX[0];
      out.y = segY[0];
      out.amplitude = segAmp[0];
      return true;
    }
    if (t >= tMax) {
      const idx = len - 1;
      out.x = segX[idx];
      out.y = segY[idx];
      out.amplitude = segAmp[idx];
      return true;
    }

    // Binary search for the bracketing vertices (segment is sorted by t)
    let left = 0;
    let right = len - 1;
    while (left < right - 1) {
      const mid = Math.floor((left + right) / 2);
      if (segT[mid] <= t) {
        left = mid;
      } else {
        right = mid;
      }
    }

    const span = segT[right] - segT[left];
    const f = span > 0 ? (t - segT[left]) / span : 0;
    out.x = lerpScalar(segX[left], segX[right], f);
    out.y = lerpScalar(segY[left], segY[right], f);
    out.amplitude = lerpScalar(segAmp[left], segAmp[right], f);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Row decimation
// ---------------------------------------------------------------------------

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
  if (LOG_DECIMATION_STATS) rowDecimationEvaluationCalls++;
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
  const anchorSample: StepSample = { x: 0, y: 0, amplitude: 0 };
  const endpointSample: StepSample = { x: 0, y: 0, amplitude: 0 };

  for (const segment of row) {
    const segX = segment.x;
    const segY = segment.y;
    const segT = segment.t;
    const segAmp = segment.amplitude;

    for (let i = 0; i < segT.length; i++) {
      const pointT = segT[i];

      if (!sampleStepAtT(anchor, pointT, anchorSample)) {
        return { removable: false, score: Number.POSITIVE_INFINITY };
      }

      if (!sampleStepAtT(endpoint, pointT, endpointSample)) {
        return { removable: false, score: Number.POSITIVE_INFINITY };
      }

      // Position error.
      const ix = lerpScalar(anchorSample.x, endpointSample.x, fraction);
      const iy = lerpScalar(anchorSample.y, endpointSample.y, fraction);
      const dx = segX[i] - ix;
      const dy = segY[i] - iy;
      const posErrSq = dx * dx + dy * dy;
      const posScore = normalizedError(posErrSq, posTolSq);
      if (posScore > 1) {
        return { removable: false, score: Number.POSITIVE_INFINITY };
      }
      if (posScore > maxError) maxError = posScore;

      // Amplitude error.
      const iAmp = lerpScalar(
        anchorSample.amplitude,
        endpointSample.amplitude,
        fraction,
      );
      const ampErr = Math.abs(segAmp[i] - iAmp);
      const ampScore = normalizedError(ampErr, ampTol);
      if (ampScore > 1) {
        return { removable: false, score: Number.POSITIVE_INFINITY };
      }
      if (ampScore > maxError) maxError = ampScore;

      // Phase-offset error.
      // phaseOffset = stepIndex * phasePerStep − k * dot(position, waveDir)
      const actualPhase =
        rowPhaseBase - k * (segX[i] * waveDx + segY[i] * waveDy);
      const anchorPhase =
        anchorPhaseBase -
        k * (anchorSample.x * waveDx + anchorSample.y * waveDy);
      const endpointPhase =
        endpointPhaseBase -
        k * (endpointSample.x * waveDx + endpointSample.y * waveDy);
      const iPhase = lerpScalar(anchorPhase, endpointPhase, fraction);
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
    if (active[rowIdx] === 0) continue;
    if (prev[rowIdx] !== prevIdx || next[rowIdx] !== nextIdx) continue;

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
  if (LOG_DECIMATION_STATS) canRemoveVerticesBetweenCalls++;

  const t = segment.t;
  const x = segment.x;
  const y = segment.y;
  const amplitude = segment.amplitude;

  const aT = t[anchorIdx];
  const bT = t[endpointIdx];
  const tSpan = bT - aT;

  const ax = x[anchorIdx];
  const ay = y[anchorIdx];
  const bx = x[endpointIdx];
  const by = y[endpointIdx];

  const aAmp = amplitude[anchorIdx];
  const bAmp = amplitude[endpointIdx];

  for (let i = anchorIdx + 1; i < endpointIdx; i++) {
    const f = tSpan > 0 ? (t[i] - aT) / tSpan : 0;

    const ix = lerpScalar(ax, bx, f);
    const iy = lerpScalar(ay, by, f);
    const dx = x[i] - ix;
    const dy = y[i] - iy;
    if (dx * dx + dy * dy > posTolSq) return false;

    const iAmp = lerpScalar(aAmp, bAmp, f);
    if (Math.abs(amplitude[i] - iAmp) > ampTol) return false;
  }

  return true;
}

function copyKeptIndices(
  source: number[],
  kept: number[],
  out: number[],
): void {
  for (let i = 0; i < kept.length; i++) {
    out[i] = source[kept[i]];
  }
}

function buildSegmentFromKept(
  segment: WavefrontSegment,
  kept: number[],
): WavefrontSegment {
  const n = kept.length;

  const outX = new Array<number>(n);
  const outY = new Array<number>(n);
  const outT = new Array<number>(n);
  const outDirX = new Array<number>(n);
  const outDirY = new Array<number>(n);
  const outEnergy = new Array<number>(n);
  const outBroken = new Array<number>(n);
  const outDepth = new Array<number>(n);
  const outAmplitude = new Array<number>(n);

  copyKeptIndices(segment.x, kept, outX);
  copyKeptIndices(segment.y, kept, outY);
  copyKeptIndices(segment.t, kept, outT);
  copyKeptIndices(segment.dirX, kept, outDirX);
  copyKeptIndices(segment.dirY, kept, outDirY);
  copyKeptIndices(segment.energy, kept, outEnergy);
  copyKeptIndices(segment.broken, kept, outBroken);
  copyKeptIndices(segment.depth, kept, outDepth);
  copyKeptIndices(segment.amplitude, kept, outAmplitude);

  return {
    x: outX,
    y: outY,
    t: outT,
    dirX: outDirX,
    dirY: outDirY,
    energy: outEnergy,
    broken: outBroken,
    depth: outDepth,
    amplitude: outAmplitude,
  };
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
  const len = segment.t.length;
  if (len <= 2) return segment;

  const kept: number[] = [0];
  let anchor = 0;
  let endpoint = 2;

  while (endpoint <= len - 1) {
    const removable = canRemoveVerticesBetween(
      segment,
      anchor,
      endpoint,
      posTolSq,
      ampTol,
    );

    if (removable) {
      if (endpoint === len - 1) {
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

  if (kept[kept.length - 1] !== len - 1) {
    kept.push(len - 1);
  }

  if (kept.length === len) return segment;
  return buildSegmentFromKept(segment, kept);
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

  if (LOG_DECIMATION_STATS) {
    sampleStepAtTCalls = 0;
    rowDecimationEvaluationCalls = 0;
    canRemoveVerticesBetweenCalls = 0;
  }

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
  if (LOG_DECIMATION_STATS) {
    sampleStepAtTCalls = 0;
  }

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

  if (LOG_DECIMATION_STATS) {
    // Single consolidated log
    console.log(
      `Decimation stats: ${totalTime.toFixed(1)}ms total\n` +
        `  Input: ${rowsBefore} rows, ${verticesBefore} vertices\n` +
        `  Output: ${rowDecimated.length} rows (-${rowsBefore - rowDecimated.length}), ${verticesAfter} vertices (-${verticesBefore - verticesAfter})\n` +
        `  Row decimation: ${rowDecimationTime.toFixed(1)}ms, ${rowDecimationCalls} row evaluations, ${sampleCallsPhase1} sampleStepAtT calls\n` +
        `  Vertex decimation: ${vertexDecimationTime.toFixed(1)}ms, ${totalSegments} segments, ${vertexDecimationCalls} canRemoveVerticesBetween calls, ${sampleCallsPhase2} sampleStepAtT calls`,
    );
  }

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
      count += segment.t.length;
    }
  }
  return count;
}
