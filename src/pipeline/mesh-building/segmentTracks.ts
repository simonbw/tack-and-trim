import type { WavefrontSegment } from "./marchingTypes";

/**
 * A segment snapshot at a specific march step.
 * `rowIndex` is the position in the original wavefront step array.
 */
export interface SegmentTrackSnapshot {
  rowIndex: number;
  segmentIndex: number;
  sourceStepIndex: number;
  segment: WavefrontSegment;
}

/**
 * A lineage-preserving segment track.
 * Each track is a time-ordered list of snapshots for one segment branch.
 */
export interface SegmentTrack {
  trackId: number;
  parentTrackId: number | null;
  childTrackIds: number[];
  snapshots: SegmentTrackSnapshot[];
}

