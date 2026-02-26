import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Wavefront, WavefrontSegment } from "../marchingTypes";
import { buildSegmentTracks } from "../buildSegmentTracks";

function makeSegment(
  trackId: number,
  parentTrackId: number | null,
  sourceStepIndex: number,
  minT: number,
  maxT: number,
): WavefrontSegment {
  const midT = (minT + maxT) / 2;
  return {
    trackId,
    parentTrackId,
    sourceStepIndex,
    x: [0, 1, 2],
    y: [0, 0, 0],
    t: [minT, midT, maxT],
    dirX: [],
    dirY: [],
    energy: [],
    turbulence: [0, 0, 0],
    depth: [],
    amplitude: [1, 1, 1],
    blend: [1, 1, 1],
  };
}

describe("buildSegmentTracks", () => {
  it("groups snapshots by trackId", () => {
    const rows: Wavefront[] = [
      [makeSegment(10, null, 10, 0, 1)],
      [makeSegment(10, null, 11, 0, 1)],
      [makeSegment(10, null, 12, 0, 1)],
    ];

    const result = buildSegmentTracks(rows);

    assert.equal(result.tracks.length, 1);
    assert.equal(result.splitCount, 0);
    assert.equal(result.mergeCount, 0);
    assert.deepEqual(
      result.tracks[0].snapshots.map((s) => s.sourceStepIndex),
      [10, 11, 12],
    );
  });

  it("links child tracks through parentTrackId", () => {
    const rows: Wavefront[] = [
      [makeSegment(0, null, 0, 0, 1)],
      [makeSegment(1, 0, 1, 0, 0.5), makeSegment(2, 0, 1, 0.5, 1)],
    ];

    const result = buildSegmentTracks(rows);

    assert.equal(result.tracks.length, 3);
    assert.equal(result.splitCount, 1);
    assert.equal(result.mergeCount, 0);

    const root = result.tracks.find((t) => t.trackId === 0);
    assert.ok(root);
    assert.deepEqual(root.childTrackIds, [1, 2]);
  });
});
