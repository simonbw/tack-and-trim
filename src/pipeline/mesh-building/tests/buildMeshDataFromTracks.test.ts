import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildMeshDataFromTracks,
  countMeshTopologyFromTracks,
} from "../buildMeshDataFromTracks";
import type { WaveBounds, Wavefront } from "../marchingTypes";
import { buildSegmentTracks } from "../buildSegmentTracks";

function makeRows(): Wavefront[] {
  return [
    [
      {
        trackId: 0,
        parentTrackId: null,
        sourceStepIndex: 0,
        x: [0, 1, 2],
        y: [0, 0, 0],
        t: [0, 0.5, 1],
        dirX: [],
        dirY: [],
        energy: [],
        turbulence: [0, 0, 0],
        depth: [],
        amplitude: [1, 1, 1],
        blend: [1, 1, 1],
      },
    ],
    [
      {
        trackId: 0,
        parentTrackId: null,
        sourceStepIndex: 1,
        x: [0, 1, 2],
        y: [1, 1, 1],
        t: [0, 0.5, 1],
        dirX: [],
        dirY: [],
        energy: [],
        turbulence: [0, 0, 0],
        depth: [],
        amplitude: [1, 1, 1],
        blend: [1, 1, 1],
      },
    ],
  ];
}

describe("meshOutput", () => {
  it("builds topology with valid indices and expected counts", () => {
    const wavefronts = makeRows();
    const tracks = buildSegmentTracks(wavefronts).tracks;
    const bounds: WaveBounds = {
      minProj: 0,
      maxProj: 10,
      minPerp: -5,
      maxPerp: 5,
    };
    const topology = countMeshTopologyFromTracks(tracks);
    const mesh = buildMeshDataFromTracks(tracks, 100, 1, 0, bounds, Math.PI);

    assert.equal(mesh.vertexCount, topology.vertexCount);
    assert.equal(mesh.indexCount / 3, topology.triangleCount);
    assert.equal(mesh.indexCount, 12);

    for (let i = 0; i < mesh.indexCount; i++) {
      const idx = mesh.indices[i];
      assert.ok(
        idx >= 0 && idx < mesh.vertexCount,
        `index ${idx} at ${i} is out of range`,
      );
    }
  });

  it("computes phase from sourceStepIndex and coverage quad corners", () => {
    const wavefronts = makeRows();
    const tracks = buildSegmentTracks(wavefronts).tracks;
    const bounds: WaveBounds = {
      minProj: 0,
      maxProj: 10,
      minPerp: -2,
      maxPerp: 2,
    };
    const wavelength = 20;
    const k = (2 * Math.PI) / wavelength;
    const phasePerStep = 0.7;
    const mesh = buildMeshDataFromTracks(
      tracks,
      wavelength,
      1,
      0,
      bounds,
      phasePerStep,
    );

    const phaseOffsetIndex = 4;
    const firstVertexPhase = mesh.vertices[phaseOffsetIndex];
    const expectedFirstPhase = 0 * phasePerStep - k * 0;
    assert.ok(Math.abs(firstVertexPhase - expectedFirstPhase) < 1e-6);

    const secondRowFirstVertex = 3;
    const secondRowPhase = mesh.vertices[secondRowFirstVertex * 6 + phaseOffsetIndex];
    const expectedSecondRowPhase = 1 * phasePerStep - k * 0;
    assert.ok(Math.abs(secondRowPhase - expectedSecondRowPhase) < 1e-6);

    assert.deepEqual(mesh.coverageQuad, {
      x0: 0,
      y0: -2,
      x1: 10,
      y1: -2,
      x2: 10,
      y2: 2,
      x3: 0,
      y3: 2,
    });
  });

  it("triangulates across skipped intermediate rows in a track", () => {
    const wavefronts: Wavefront[] = [
      [
        {
          trackId: 0,
          parentTrackId: null,
          sourceStepIndex: 0,
          x: [0, 1, 2],
          y: [0, 0, 0],
          t: [0, 0.5, 1],
          dirX: [],
          dirY: [],
          energy: [],
          turbulence: [0, 0, 0],
          depth: [],
          amplitude: [1, 1, 1],
          blend: [1, 1, 1],
        },
      ],
      [
        {
          trackId: 0,
          parentTrackId: null,
          sourceStepIndex: 1,
          x: [0, 1, 2],
          y: [1, 1, 1],
          t: [0, 0.5, 1],
          dirX: [],
          dirY: [],
          energy: [],
          turbulence: [0, 0, 0],
          depth: [],
          amplitude: [1, 1, 1],
          blend: [1, 1, 1],
        },
      ],
      [
        {
          trackId: 0,
          parentTrackId: null,
          sourceStepIndex: 2,
          x: [0, 1, 2],
          y: [2, 2, 2],
          t: [0, 0.5, 1],
          dirX: [],
          dirY: [],
          energy: [],
          turbulence: [0, 0, 0],
          depth: [],
          amplitude: [1, 1, 1],
          blend: [1, 1, 1],
        },
      ],
    ];
    const tracksResult = buildSegmentTracks(wavefronts);
    tracksResult.tracks[0].snapshots.splice(1, 1);

    const bounds: WaveBounds = {
      minProj: 0,
      maxProj: 10,
      minPerp: -2,
      maxPerp: 2,
    };
    const mesh = buildMeshDataFromTracks(
      tracksResult.tracks,
      100,
      1,
      0,
      bounds,
      Math.PI,
    );

    assert.ok(mesh.indexCount > 0);
    for (let i = 0; i < mesh.indexCount; i++) {
      assert.ok(mesh.indices[i] < mesh.vertexCount);
    }
  });

  it("stitches split boundaries between parent and child tracks", () => {
    const wavefronts: Wavefront[] = [
      [
        {
          trackId: 0,
          parentTrackId: null,
          sourceStepIndex: 0,
          x: [0, 1, 2, 3, 4],
          y: [0, 0, 0, 0, 0],
          t: [0, 0.25, 0.5, 0.75, 1],
          dirX: [],
          dirY: [],
          energy: [],
          turbulence: [0, 0, 0, 0, 0],
          depth: [],
          amplitude: [1, 1, 1, 1, 1],
          blend: [1, 1, 1, 1, 1],
        },
      ],
      [
        {
          trackId: 1,
          parentTrackId: 0,
          sourceStepIndex: 1,
          x: [0, 0.5, 1, 1.5, 2],
          y: [1, 1, 1, 1, 1],
          t: [0, 0.125, 0.25, 0.375, 0.5],
          dirX: [],
          dirY: [],
          energy: [],
          turbulence: [0, 0, 0, 0, 0],
          depth: [],
          amplitude: [1, 1, 1, 1, 1],
          blend: [1, 1, 1, 1, 1],
        },
        {
          trackId: 2,
          parentTrackId: 0,
          sourceStepIndex: 1,
          x: [2, 2.5, 3, 3.5, 4],
          y: [1, 1, 1, 1, 1],
          t: [0.5, 0.625, 0.75, 0.875, 1],
          dirX: [],
          dirY: [],
          energy: [],
          turbulence: [0, 0, 0, 0, 0],
          depth: [],
          amplitude: [1, 1, 1, 1, 1],
          blend: [1, 1, 1, 1, 1],
        },
      ],
    ];
    const tracks = buildSegmentTracks(wavefronts).tracks;
    const bounds: WaveBounds = {
      minProj: 0,
      maxProj: 10,
      minPerp: -2,
      maxPerp: 2,
    };

    const mesh = buildMeshDataFromTracks(tracks, 100, 1, 0, bounds, Math.PI);
    const topology = countMeshTopologyFromTracks(tracks);

    assert.ok(topology.triangleCount > 0);
    assert.equal(mesh.indexCount / 3, topology.triangleCount);
    assert.ok(mesh.indexCount > 0);
    for (let i = 0; i < mesh.indexCount; i++) {
      assert.ok(mesh.indices[i] < mesh.vertexCount);
    }
  });
});
