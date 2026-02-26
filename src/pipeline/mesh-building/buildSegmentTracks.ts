import type { Wavefront } from "./marchingTypes";
import type { SegmentTrack } from "./segmentTracks";

export interface BuildSegmentTracksResult {
  tracks: SegmentTrack[];
  trackIdByRowSegment: number[][];
  splitCount: number;
  mergeCount: number;
}

/**
 * Test/helper path that reconstructs tracks from row-ordered wavefronts.
 * Runtime marching code builds tracks directly in `marchWavefronts`.
 */
export function buildSegmentTracks(
  wavefronts: readonly Wavefront[],
): BuildSegmentTracksResult {
  if (wavefronts.length === 0) {
    return {
      tracks: [],
      trackIdByRowSegment: [],
      splitCount: 0,
      mergeCount: 0,
    };
  }

  const trackIdByRowSegment: number[][] = new Array(wavefronts.length);
  const trackMap = new Map<number, SegmentTrack>();

  for (let rowIndex = 0; rowIndex < wavefronts.length; rowIndex++) {
    const row = wavefronts[rowIndex];
    const rowTrackIds = new Array<number>(row.length);
    trackIdByRowSegment[rowIndex] = rowTrackIds;

    for (let segmentIndex = 0; segmentIndex < row.length; segmentIndex++) {
      const segment = row[segmentIndex];
      const trackId = segment.trackId;
      rowTrackIds[segmentIndex] = trackId;

      let track = trackMap.get(trackId);
      if (!track) {
        track = {
          trackId,
          parentTrackId: segment.parentTrackId,
          childTrackIds: [],
          snapshots: [],
        };
        trackMap.set(trackId, track);
      }

      track.snapshots.push({
        rowIndex,
        segmentIndex,
        sourceStepIndex: segment.sourceStepIndex,
        segment,
      });
    }
  }

  const tracks = Array.from(trackMap.values()).sort((a, b) => a.trackId - b.trackId);
  const childrenByParent = new Map<number, Set<number>>();

  for (const track of tracks) {
    track.snapshots.sort((a, b) => {
      if (a.sourceStepIndex !== b.sourceStepIndex) {
        return a.sourceStepIndex - b.sourceStepIndex;
      }
      return a.rowIndex - b.rowIndex;
    });

    if (track.parentTrackId !== null) {
      const children = childrenByParent.get(track.parentTrackId) ?? new Set<number>();
      children.add(track.trackId);
      childrenByParent.set(track.parentTrackId, children);
    }
  }

  let splitCount = 0;
  for (const track of tracks) {
    const children = childrenByParent.get(track.trackId);
    track.childTrackIds = children ? Array.from(children).sort((a, b) => a - b) : [];
    if (track.childTrackIds.length > 1) {
      splitCount++;
    }
  }

  return {
    tracks,
    trackIdByRowSegment,
    splitCount,
    mergeCount: 0,
  };
}
