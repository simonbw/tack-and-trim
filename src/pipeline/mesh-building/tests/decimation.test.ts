import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decimateWavefronts } from "../decimation";
import type { Wavefront, WavefrontSegment } from "../marchingTypes";

function makeSegment(stepIndex: number): WavefrontSegment {
  const x0 = stepIndex * 10;
  const x1 = x0 + 5;
  const x2 = x0 + 10;
  const y = 0;
  return {
    sourceStepIndex: stepIndex,
    x: [x0, x1, x2],
    y: [y, y, y],
    t: [0, 0.5, 1],
    dirX: [],
    dirY: [],
    energy: [],
    turbulence: [0, 0, 0],
    depth: [],
    amplitude: [1, 1, 1],
    blend: [1, 1, 1],
  };
}

function makeLinearWavefronts(rowCount: number): Wavefront[] {
  return Array.from({ length: rowCount }, (_, i) => [makeSegment(i)]);
}

describe("decimateWavefronts", () => {
  it("removes redundant rows and returns correct step indices", () => {
    const wavefronts = makeLinearWavefronts(5);
    const wavelength = 100;
    const k = (2 * Math.PI) / wavelength;
    const stepDistance = 10;
    const phasePerStep = k * stepDistance;

    const result = decimateWavefronts(
      wavefronts,
      wavelength,
      1,
      0,
      0.01,
      phasePerStep,
    );

    assert.deepEqual(result.sourceRowIndices, [0, 4]);
    assert.deepEqual(result.stepIndices, [0, 4]);
    assert.equal(result.wavefronts.length, 2);
    assert.equal(result.removedRows, 3);
    assert.ok(result.removedVertices > 0);
  });

  it("keeps first and last rows even at high tolerance", () => {
    const wavefronts = makeLinearWavefronts(3);
    const result = decimateWavefronts(wavefronts, 100, 1, 0, 1.0);
    assert.deepEqual(result.sourceRowIndices, [0, 2]);
    assert.equal(result.wavefronts.length, 2);
  });
});
