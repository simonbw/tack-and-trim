import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Wavefront, WavefrontSegment } from "../marchingTypes";
import { decimateWavefrontTracks } from "../decimateWavefrontTracks";

function makeSegment(
  sourceStepIndex: number,
  xOffset: number,
  minT: number,
  maxT: number,
  yValue: number = 0,
): WavefrontSegment {
  const tMid = (minT + maxT) / 2;
  return {
    sourceStepIndex,
    x: [xOffset, xOffset + 1, xOffset + 2],
    y: [yValue, yValue, yValue],
    t: [minT, tMid, maxT],
    dirX: [],
    dirY: [],
    energy: [],
    turbulence: [0, 0, 0],
    depth: [],
    amplitude: [1, 1, 1],
    blend: [1, 1, 1],
  };
}

describe("decimateWavefrontTracks", () => {
  it("removes middle snapshots on a linear single track", () => {
    const wavefronts: Wavefront[] = [
      [makeSegment(0, 0, 0, 1)],
      [makeSegment(1, 10, 0, 1)],
      [makeSegment(2, 20, 0, 1)],
      [makeSegment(3, 30, 0, 1)],
      [makeSegment(4, 40, 0, 1)],
    ];

    const wavelength = 100;
    const k = (2 * Math.PI) / wavelength;
    const phasePerStep = k * 10;
    const result = decimateWavefrontTracks(
      wavefronts,
      wavelength,
      1,
      0,
      0.01,
      phasePerStep,
    );

    assert.deepEqual(result.keptSourceStepIndices, [0, 4]);
    assert.equal(result.wavefronts.length, 2);
    assert.ok(result.removedSegmentSnapshots >= 3);
  });

  it("can keep different source-step sets per track", () => {
    const wavefronts: Wavefront[] = [
      [makeSegment(0, 0, 0, 0.5), makeSegment(0, 0, 0.5, 1)],
      [makeSegment(1, 10, 0, 0.5), makeSegment(1, 2, 0.5, 1, 5)],
      [makeSegment(2, 20, 0, 0.5), makeSegment(2, 4, 0.5, 1, 0)],
      [makeSegment(3, 30, 0, 0.5), makeSegment(3, 6, 0.5, 1, 5)],
      [makeSegment(4, 40, 0, 0.5), makeSegment(4, 8, 0.5, 1)],
    ];

    const wavelength = 100;
    const k = (2 * Math.PI) / wavelength;
    const phasePerStep = k * 10;
    const result = decimateWavefrontTracks(
      wavefronts,
      wavelength,
      1,
      0,
      0.01,
      phasePerStep,
    );

    const rowLengths = result.wavefronts.map((row) => row.length);
    assert.ok(rowLengths.some((len) => len === 1));
    assert.ok(rowLengths.some((len) => len === 2));
  });
});
