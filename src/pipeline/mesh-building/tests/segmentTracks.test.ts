import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Wavefront, WavefrontSegment } from "../marchingTypes";
import { buildSegmentTracks } from "../segmentTracks";

function makeSegment(
  sourceStepIndex: number,
  minT: number,
  maxT: number,
): WavefrontSegment {
  const midT = (minT + maxT) / 2;
  return {
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
  it("keeps a single linear segment in one track", () => {
    const rows: Wavefront[] = [
      [makeSegment(10, 0, 1)],
      [makeSegment(11, 0, 1)],
      [makeSegment(12, 0, 1)],
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

  it("creates child tracks when one segment splits into multiple", () => {
    const rows: Wavefront[] = [
      [makeSegment(0, 0, 1)],
      [makeSegment(1, 0, 0.5), makeSegment(1, 0.5, 1)],
    ];

    const result = buildSegmentTracks(rows);

    assert.equal(result.tracks.length, 2);
    assert.equal(result.splitCount, 1);
    assert.equal(result.mergeCount, 0);

    const root = result.tracks.find((t) => t.parentTrackId === null);
    assert.ok(root);
    assert.equal(root.childTrackIds.length, 1);
    assert.deepEqual(
      root.snapshots.map((s) => s.rowIndex),
      [0, 1],
    );
  });

  it("counts merge events when a segment overlaps multiple parent tracks", () => {
    const rows: Wavefront[] = [
      [makeSegment(0, 0, 0.6), makeSegment(0, 0.4, 1)],
      [makeSegment(1, 0.2, 0.8)],
    ];

    const result = buildSegmentTracks(rows);

    assert.ok(result.mergeCount > 0);
  });
});

