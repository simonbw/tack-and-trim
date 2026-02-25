import type { Wavefront, WavefrontSegment } from "./marchingTypes";

export interface SegmentTrackSnapshot {
  rowIndex: number;
  segmentIndex: number;
  sourceStepIndex: number;
  segment: WavefrontSegment;
}

export interface SegmentTrack {
  trackId: number;
  parentTrackId: number | null;
  childTrackIds: number[];
  snapshots: SegmentTrackSnapshot[];
}

export interface BuildSegmentTracksResult {
  tracks: SegmentTrack[];
  trackIdByRowSegment: number[][];
  splitCount: number;
  mergeCount: number;
}

type OverlapCandidate = {
  prevSegmentIndex: number;
  prevTrackId: number;
  overlap: number;
};

function overlapSpan(a: WavefrontSegment, b: WavefrontSegment): number {
  const aLen = a.t.length;
  const bLen = b.t.length;
  if (aLen === 0 || bLen === 0) return 0;
  const min = Math.max(a.t[0], b.t[0]);
  const max = Math.min(a.t[aLen - 1], b.t[bLen - 1]);
  return max - min;
}

export function buildSegmentTracks(
  wavefronts: readonly Wavefront[],
  overlapEpsilon: number = 1e-6,
): BuildSegmentTracksResult {
  if (wavefronts.length === 0) {
    return {
      tracks: [],
      trackIdByRowSegment: [],
      splitCount: 0,
      mergeCount: 0,
    };
  }

  const tracks: SegmentTrack[] = [];
  const trackIdByRowSegment: number[][] = new Array(wavefronts.length);
  let splitCount = 0;
  let mergeCount = 0;

  const createTrack = (
    parentTrackId: number | null,
    rowIndex: number,
    segmentIndex: number,
    segment: WavefrontSegment,
  ): number => {
    const trackId = tracks.length;
    tracks.push({
      trackId,
      parentTrackId,
      childTrackIds: [],
      snapshots: [
        {
          rowIndex,
          segmentIndex,
          sourceStepIndex: segment.sourceStepIndex,
          segment,
        },
      ],
    });
    if (parentTrackId !== null) {
      tracks[parentTrackId].childTrackIds.push(trackId);
    }
    return trackId;
  };

  const firstRow = wavefronts[0];
  trackIdByRowSegment[0] = new Array(firstRow.length);
  for (let si = 0; si < firstRow.length; si++) {
    trackIdByRowSegment[0][si] = createTrack(null, 0, si, firstRow[si]);
  }

  for (let rowIndex = 1; rowIndex < wavefronts.length; rowIndex++) {
    const prevRow = wavefronts[rowIndex - 1];
    const row = wavefronts[rowIndex];
    const prevTrackIds = trackIdByRowSegment[rowIndex - 1];
    const rowTrackIds = new Array<number>(row.length);
    trackIdByRowSegment[rowIndex] = rowTrackIds;

    const parentTrackUseCount = new Map<number, number>();

    for (let si = 0; si < row.length; si++) {
      const segment = row[si];
      const overlaps: OverlapCandidate[] = [];

      for (let psi = 0; psi < prevRow.length; psi++) {
        const overlap = overlapSpan(prevRow[psi], segment);
        if (overlap > overlapEpsilon) {
          overlaps.push({
            prevSegmentIndex: psi,
            prevTrackId: prevTrackIds[psi],
            overlap,
          });
        }
      }

      if (overlaps.length === 0) {
        rowTrackIds[si] = createTrack(null, rowIndex, si, segment);
        continue;
      }

      overlaps.sort((a, b) => b.overlap - a.overlap);
      const dominantParentTrackId = overlaps[0].prevTrackId;
      const uniqueParentTrackIds = new Set(overlaps.map((c) => c.prevTrackId));
      if (uniqueParentTrackIds.size > 1) {
        mergeCount++;
      }

      const used = parentTrackUseCount.get(dominantParentTrackId) ?? 0;
      if (used === 0) {
        tracks[dominantParentTrackId].snapshots.push({
          rowIndex,
          segmentIndex: si,
          sourceStepIndex: segment.sourceStepIndex,
          segment,
        });
        rowTrackIds[si] = dominantParentTrackId;
      } else {
        splitCount++;
        rowTrackIds[si] = createTrack(dominantParentTrackId, rowIndex, si, segment);
      }
      parentTrackUseCount.set(dominantParentTrackId, used + 1);
    }
  }

  return { tracks, trackIdByRowSegment, splitCount, mergeCount };
}

