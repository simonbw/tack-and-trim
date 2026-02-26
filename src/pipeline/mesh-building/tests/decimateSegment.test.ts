import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decimateSegment } from "../decimateSegment";
import type { WavefrontSegment } from "../marchingTypes";

function makeSegment(xs: number[]): WavefrontSegment {
  return {
    trackId: 0,
    parentTrackId: null,
    sourceStepIndex: 0,
    x: xs,
    y: xs.map(() => 0),
    t: xs.map((_, i) => i / (xs.length - 1)),
    dirX: [],
    dirY: [],
    energy: [],
    turbulence: xs.map(() => 0),
    depth: [],
    amplitude: xs.map(() => 1),
    blend: xs.map(() => 1),
  };
}

describe("decimateSegment", () => {
  it("removes collinear interior vertices", () => {
    const segment = makeSegment([0, 5, 10, 15, 20]);
    const result = decimateSegment(segment, 0.001, 0.001);

    assert.deepEqual(result.x, [0, 20]);
    assert.equal(result.t.length, 2);
    assert.equal(result.sourceStepIndex, 0);
  });

  it("preserves vertices needed to fit curvature", () => {
    const segment = {
      ...makeSegment([0, 5, 10, 15, 20]),
      y: [0, 2, 4, 2, 0],
    };
    const result = decimateSegment(segment, 0.5, 0.001);

    assert.ok(result.t.length > 2);
    assert.equal(result.sourceStepIndex, 0);
  });
});
