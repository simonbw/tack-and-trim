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
let canRemoveRowsBetweenCalls = 0;
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

/**
 * Check whether ALL wavefront rows strictly between anchorIdx and endpointIdx
 * are well-approximated by linear interpolation between the anchor and
 * endpoint rows. Only the anchor and endpoint (both kept) are used as
 * reference — no intermediate (potentially removed) rows participate.
 */
function canRemoveRowsBetween(
  wavefronts: readonly Wavefront[],
  anchorIdx: number,
  endpointIdx: number,
  k: number,
  waveDx: number,
  waveDy: number,
  posTolSq: number,
  ampTol: number,
  phaseTol: number,
  phasePerStep: number,
): boolean {
  canRemoveRowsBetweenCalls++;
  const anchor: Wavefront = wavefronts[anchorIdx];
  const endpoint: Wavefront = wavefronts[endpointIdx];
  const span = endpointIdx - anchorIdx;

  // Cache samples from anchor and endpoint rows to avoid repeated linear searches
  const anchorCache = new Map<
    number,
    { x: number; y: number; amplitude: number }
  >();
  const endpointCache = new Map<
    number,
    { x: number; y: number; amplitude: number }
  >();

  for (let ri = anchorIdx + 1; ri < endpointIdx; ri++) {
    const row = wavefronts[ri];
    const fraction = (ri - anchorIdx) / span;

    for (const segment of row) {
      for (const point of segment) {
        // Try cache first, then compute and cache if needed
        let fromAnchor = anchorCache.get(point.t);
        if (!fromAnchor) {
          const sample = sampleStepAtT(anchor, point.t);
          if (!sample) return false; // Can't interpolate
          fromAnchor = sample;
          anchorCache.set(point.t, fromAnchor);
        }

        let fromEndpoint = endpointCache.get(point.t);
        if (!fromEndpoint) {
          const sample = sampleStepAtT(endpoint, point.t);
          if (!sample) return false; // Can't interpolate
          fromEndpoint = sample;
          endpointCache.set(point.t, fromEndpoint);
        }

        // Position error
        const ix = lerpScalar(fromAnchor.x, fromEndpoint.x, fraction);
        const iy = lerpScalar(fromAnchor.y, fromEndpoint.y, fraction);
        const dx = point.x - ix;
        const dy = point.y - iy;
        if (dx * dx + dy * dy > posTolSq) return false;

        // Amplitude error
        const iAmp = lerpScalar(
          fromAnchor.amplitude,
          fromEndpoint.amplitude,
          fraction,
        );
        if (Math.abs(point.amplitude - iAmp) > ampTol) return false;

        // Phase-offset error.
        // phaseOffset = stepIndex * phasePerStep − k * dot(position, waveDir)
        const actualPhase =
          ri * phasePerStep - k * (point.x * waveDx + point.y * waveDy);
        const anchorPhase =
          anchorIdx * phasePerStep -
          k * (fromAnchor.x * waveDx + fromAnchor.y * waveDy);
        const endpointPhase =
          endpointIdx * phasePerStep -
          k * (fromEndpoint.x * waveDx + fromEndpoint.y * waveDy);
        const iPhase = lerpScalar(anchorPhase, endpointPhase, fraction);
        if (Math.abs(actualPhase - iPhase) > phaseTol) return false;
      }
    }
  }
  return true;
}

/**
 * Greedy forward scan that removes entire wavefront rows.
 *
 * Maintains an "anchor" (last kept row). For each subsequent row, checks
 * whether ALL rows between the anchor and the next probe can be removed.
 * If so, extends the removal span. If not, the row just before the failing
 * probe becomes the new anchor.
 *
 * First and last rows are always kept.
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

  const kept: number[] = [0];
  let anchor = 0;
  let endpoint = 2; // minimum span: one candidate row between anchor and endpoint

  while (endpoint <= N - 1) {
    const removable = canRemoveRowsBetween(
      wavefronts,
      anchor,
      endpoint,
      k,
      waveDx,
      waveDy,
      posTolSq,
      ampTol,
      phaseTol,
      phasePerStep,
    );

    if (removable) {
      if (endpoint === N - 1) {
        // Reached the end — keep it and stop.
        kept.push(endpoint);
        break;
      }
      // Try extending the span further.
      endpoint++;
    } else {
      // The row just before the failing probe must be kept.
      kept.push(endpoint - 1);
      anchor = endpoint - 1;
      endpoint = anchor + 2;
    }
  }

  // Ensure the last row is always kept.
  if (kept[kept.length - 1] !== N - 1) {
    kept.push(N - 1);
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
  canRemoveRowsBetweenCalls = 0;
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
  const rowDecimationCalls = canRemoveRowsBetweenCalls;
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
      `  Row decimation: ${rowDecimationTime.toFixed(1)}ms, ${rowDecimationCalls} canRemoveRowsBetween calls, ${sampleCallsPhase1} sampleStepAtT calls\n` +
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
