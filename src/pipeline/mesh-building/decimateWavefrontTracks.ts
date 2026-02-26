import { decimateSegment, DEFAULT_DECIMATION_TOLERANCE } from "./decimateSegment";
import type { Wavefront, WavefrontSegment } from "./marchingTypes";
import type { SegmentTrack } from "./buildSegmentTracks";
import { lerp } from "../../core/util/MathUtil";

type SegmentSample = {
  x: number;
  y: number;
  amplitude: number;
  turbulence: number;
  blend: number;
};

function normalizedError(error: number, tolerance: number): number {
  if (tolerance <= 0) return error === 0 ? 0 : Number.POSITIVE_INFINITY;
  return error / tolerance;
}

function sampleSegmentAtT(
  segment: WavefrontSegment,
  t: number,
  out: SegmentSample,
): boolean {
  const segT = segment.t;
  const len = segT.length;
  if (len === 0) return false;

  const tMin = segT[0];
  const tMax = segT[len - 1];
  if (t < tMin - 1e-9 || t > tMax + 1e-9) return false;

  const segX = segment.x;
  const segY = segment.y;
  const segAmp = segment.amplitude;
  const segTurb = segment.turbulence;
  const segBlend = segment.blend;

  if (t <= tMin) {
    out.x = segX[0];
    out.y = segY[0];
    out.amplitude = segAmp[0];
    out.turbulence = segTurb[0];
    out.blend = segBlend[0];
    return true;
  }
  if (t >= tMax) {
    const idx = len - 1;
    out.x = segX[idx];
    out.y = segY[idx];
    out.amplitude = segAmp[idx];
    out.turbulence = segTurb[idx];
    out.blend = segBlend[idx];
    return true;
  }

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
  out.x = lerp(segX[left], segX[right], f);
  out.y = lerp(segY[left], segY[right], f);
  out.amplitude = lerp(segAmp[left], segAmp[right], f);
  out.turbulence = lerp(segTurb[left], segTurb[right], f);
  out.blend = lerp(segBlend[left], segBlend[right], f);
  return true;
}

function evaluateTrackSnapshotRemoval(
  track: SegmentTrack,
  snapshotIndex: number,
  anchorSnapshotIndex: number,
  endpointSnapshotIndex: number,
  k: number,
  waveDx: number,
  waveDy: number,
  posTolSq: number,
  ampTol: number,
  phaseTol: number,
  phasePerStep: number,
): boolean {
  const snapshot = track.snapshots[snapshotIndex].segment;
  const anchor = track.snapshots[anchorSnapshotIndex].segment;
  const endpoint = track.snapshots[endpointSnapshotIndex].segment;
  const span = endpointSnapshotIndex - anchorSnapshotIndex;
  if (span <= 1) return false;

  const fraction = (snapshotIndex - anchorSnapshotIndex) / span;
  const rowPhaseBase = snapshot.sourceStepIndex * phasePerStep;
  const anchorPhaseBase = anchor.sourceStepIndex * phasePerStep;
  const endpointPhaseBase = endpoint.sourceStepIndex * phasePerStep;

  const anchorSample: SegmentSample = {
    x: 0,
    y: 0,
    amplitude: 0,
    turbulence: 0,
    blend: 0,
  };
  const endpointSample: SegmentSample = {
    x: 0,
    y: 0,
    amplitude: 0,
    turbulence: 0,
    blend: 0,
  };

  const segX = snapshot.x;
  const segY = snapshot.y;
  const segT = snapshot.t;
  const segAmp = snapshot.amplitude;
  const segTurb = snapshot.turbulence;
  const segBlend = snapshot.blend;

  for (let i = 0; i < segT.length; i++) {
    const pointT = segT[i];
    if (!sampleSegmentAtT(anchor, pointT, anchorSample)) return false;
    if (!sampleSegmentAtT(endpoint, pointT, endpointSample)) return false;

    const ix = lerp(anchorSample.x, endpointSample.x, fraction);
    const iy = lerp(anchorSample.y, endpointSample.y, fraction);
    const dx = segX[i] - ix;
    const dy = segY[i] - iy;
    if (normalizedError(dx * dx + dy * dy, posTolSq) > 1) return false;

    const iAmp = lerp(anchorSample.amplitude, endpointSample.amplitude, fraction);
    if (normalizedError(Math.abs(segAmp[i] - iAmp), ampTol) > 1) return false;

    const iTurb = lerp(
      anchorSample.turbulence,
      endpointSample.turbulence,
      fraction,
    );
    if (normalizedError(Math.abs(segTurb[i] - iTurb), ampTol) > 1) return false;

    const iBlend = lerp(anchorSample.blend, endpointSample.blend, fraction);
    if (normalizedError(Math.abs(segBlend[i] - iBlend), ampTol) > 1) return false;

    const actualPhase = rowPhaseBase - k * (segX[i] * waveDx + segY[i] * waveDy);
    const anchorPhase =
      anchorPhaseBase - k * (anchorSample.x * waveDx + anchorSample.y * waveDy);
    const endpointPhase =
      endpointPhaseBase - k * (endpointSample.x * waveDx + endpointSample.y * waveDy);
    const iPhase = lerp(anchorPhase, endpointPhase, fraction);
    if (normalizedError(Math.abs(actualPhase - iPhase), phaseTol) > 1) return false;
  }

  return true;
}

function keepSnapshotMaskForTrack(
  track: SegmentTrack,
  k: number,
  waveDx: number,
  waveDy: number,
  posTolSq: number,
  ampTol: number,
  phaseTol: number,
  phasePerStep: number,
): boolean[] {
  const len = track.snapshots.length;
  if (len <= 2) return Array.from({ length: len }, () => true);

  const keep = Array.from({ length: len }, () => false);
  keep[0] = true;
  keep[len - 1] = true;

  let anchor = 0;
  let endpoint = 2;

  while (endpoint <= len - 1) {
    const removable = evaluateTrackSnapshotRemoval(
      track,
      endpoint - 1,
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
      if (endpoint === len - 1) break;
      endpoint++;
    } else {
      keep[endpoint - 1] = true;
      anchor = endpoint - 1;
      endpoint = anchor + 2;
    }
  }

  return keep;
}

function countVerticesInRows(wavefronts: readonly Wavefront[]): number {
  let count = 0;
  for (const step of wavefronts) {
    for (const segment of step) {
      count += segment.t.length;
    }
  }
  return count;
}

function countVerticesInTracks(tracks: readonly SegmentTrack[]): number {
  let count = 0;
  for (const track of tracks) {
    for (const snapshot of track.snapshots) {
      count += snapshot.segment.t.length;
    }
  }
  return count;
}

function countRowsInTracks(tracks: readonly SegmentTrack[]): number {
  const rowSet = new Set<number>();
  for (const track of tracks) {
    for (const snapshot of track.snapshots) {
      rowSet.add(snapshot.rowIndex);
    }
  }
  return rowSet.size;
}

export interface TrackDecimationResult {
  tracks: SegmentTrack[];
  wavefronts: Wavefront[];
  keptSourceStepIndices: number[];
  removedSegmentSnapshots: number;
  removedRows: number;
  removedVertices: number;
}

/**
 * Decimate per segment-track on marched rows.
 *
 * This intentionally does not enforce row-adjacent connectivity constraints.
 * Current row-adjacent triangulation cannot consume the output safely in all
 * cases where tracks keep different source-step sets.
 */
export function decimateWavefrontTracks(
  tracks: SegmentTrack[],
  wavelength: number,
  waveDx: number,
  waveDy: number,
  tolerance: number = DEFAULT_DECIMATION_TOLERANCE,
  phasePerStep: number = Math.PI,
): TrackDecimationResult {
  if (tracks.length === 0) {
    return {
      tracks: [],
      wavefronts: [],
      keptSourceStepIndices: [],
      removedSegmentSnapshots: 0,
      removedRows: 0,
      removedVertices: 0,
    };
  }

  const k = (2 * Math.PI) / wavelength;
  const posTolSq = (tolerance * wavelength) ** 2;
  const ampTol = tolerance;
  const phaseTol = tolerance * Math.PI;
  const verticesBefore = countVerticesInTracks(tracks);
  const rowsBefore = countRowsInTracks(tracks);

  const decimatedTrackMap = new Map<number, SegmentTrack>();
  for (const track of tracks) {
    decimatedTrackMap.set(track.trackId, {
      trackId: track.trackId,
      parentTrackId: track.parentTrackId,
      childTrackIds: [...track.childTrackIds],
      snapshots: [],
    });
  }
  const rowBuckets = new Map<number, Array<{ segmentIndex: number; segment: WavefrontSegment }>>();
  let removedSegmentSnapshots = 0;

  for (const track of tracks) {
    const outTrack = decimatedTrackMap.get(track.trackId);
    if (!outTrack) continue;
    const keepMask = keepSnapshotMaskForTrack(
      track,
      k,
      waveDx,
      waveDy,
      posTolSq,
      ampTol,
      phaseTol,
      phasePerStep,
    );

    for (let i = 0; i < track.snapshots.length; i++) {
      const snapshot = track.snapshots[i];
      if (!keepMask[i]) {
        removedSegmentSnapshots++;
        continue;
      }

      const decimatedSegment = decimateSegment(snapshot.segment, posTolSq, ampTol);
      outTrack.snapshots.push({
        rowIndex: snapshot.rowIndex,
        segmentIndex: snapshot.segmentIndex,
        sourceStepIndex: snapshot.sourceStepIndex,
        segment: decimatedSegment,
      });
      const row = rowBuckets.get(snapshot.rowIndex);
      if (row) {
        row.push({ segmentIndex: snapshot.segmentIndex, segment: decimatedSegment });
      } else {
        rowBuckets.set(snapshot.rowIndex, [
          { segmentIndex: snapshot.segmentIndex, segment: decimatedSegment },
        ]);
      }
    }
  }

  const keptRowIndices = Array.from(rowBuckets.keys()).sort((a, b) => a - b);
  const resultRows: Wavefront[] = keptRowIndices.map((rowIndex) => {
    const entries = rowBuckets.get(rowIndex) ?? [];
    entries.sort((a, b) => a.segmentIndex - b.segmentIndex);
    return entries.map((entry) => entry.segment);
  });

  const keptSourceStepIndices = resultRows.map((row) => row[0].sourceStepIndex);
  const verticesAfter = countVerticesInRows(resultRows);
  const nonEmptyTracks = Array.from(decimatedTrackMap.values()).filter(
    (track) => track.snapshots.length > 0,
  );

  return {
    tracks: nonEmptyTracks,
    wavefronts: resultRows,
    keptSourceStepIndices,
    removedSegmentSnapshots,
    removedRows: rowsBefore - resultRows.length,
    removedVertices: verticesBefore - verticesAfter,
  };
}
