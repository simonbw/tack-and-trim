import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TerrainCPUData } from "../../../game/world/terrain/TerrainCPUData";
import {
  generateInitialWavefront,
  marchWavefronts,
} from "../marching";
import type { WaveBounds, WavefrontSegment } from "../marchingTypes";

function buildOpenOceanTerrain(defaultDepth: number = -200): TerrainCPUData {
  return {
    vertexData: new Float32Array(0),
    contourData: new ArrayBuffer(0),
    childrenData: new Uint32Array(0),
    contourCount: 0,
    defaultDepth,
  };
}

function assertSegmentInvariants(segment: WavefrontSegment): void {
  const len = segment.t.length;
  assert.equal(segment.x.length, len);
  assert.equal(segment.y.length, len);
  assert.equal(segment.amplitude.length, len);
  assert.equal(segment.turbulence.length, len);
  assert.equal(segment.blend.length, len);

  for (let i = 0; i < len; i++) {
    assert.ok(Number.isFinite(segment.x[i]), `x[${i}] is not finite`);
    assert.ok(Number.isFinite(segment.y[i]), `y[${i}] is not finite`);
    assert.ok(
      Number.isFinite(segment.amplitude[i]),
      `amplitude[${i}] is not finite`,
    );
    assert.ok(
      Number.isFinite(segment.turbulence[i]),
      `turbulence[${i}] is not finite`,
    );
    assert.ok(Number.isFinite(segment.blend[i]), `blend[${i}] is not finite`);
    if (i > 0) {
      assert.ok(
        segment.t[i] >= segment.t[i - 1],
        `t is not monotonic at ${i - 1} -> ${i}`,
      );
    }
  }
}

describe("marchWavefronts invariants", () => {
  it("preserves sentinel endpoints and monotonic t in open ocean", () => {
    const bounds: WaveBounds = {
      minProj: 0,
      maxProj: 120,
      minPerp: -40,
      maxPerp: 40,
    };
    const waveDx = 1;
    const waveDy = 0;
    const wavelength = 80;
    const stepSize = 20;
    const vertexSpacing = 20;
    const terrain = buildOpenOceanTerrain();

    const first = generateInitialWavefront(
      bounds,
      vertexSpacing,
      waveDx,
      waveDy,
      wavelength,
    );
    const result = marchWavefronts(
      first,
      waveDx,
      waveDy,
      stepSize,
      vertexSpacing,
      bounds,
      terrain,
      wavelength,
    );

    assert.ok(result.wavefronts.length > 0);

    for (const step of result.wavefronts) {
      assert.ok(step.length > 0);
      let sawLeftSentinel = false;
      let sawRightSentinel = false;

      for (const segment of step) {
        assertSegmentInvariants(segment);
        if (segment.t.length > 0 && segment.t[0] === 0) {
          sawLeftSentinel = true;
        }
        if (
          segment.t.length > 0 &&
          segment.t[segment.t.length - 1] === 1
        ) {
          sawRightSentinel = true;
        }
      }

      assert.ok(sawLeftSentinel, "expected a t=0 sentinel in step");
      assert.ok(sawRightSentinel, "expected a t=1 sentinel in step");
    }
  });
});
