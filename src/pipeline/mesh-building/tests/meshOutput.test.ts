import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildMeshData,
  buildMeshDataFromTracks,
  countMeshTopology,
  countMeshTopologyFromTracks,
} from "../meshOutput";
import { createIndexedPhaseModel } from "../phaseModel";
import type { WaveBounds, Wavefront } from "../marchingTypes";
import { VERTEX_FLOATS } from "../marchingTypes";
import { buildSegmentTracks } from "../segmentTracks";

function makeTwoRowWavefronts(): Wavefront[] {
  return [
    [
      {
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
    const wavefronts = makeTwoRowWavefronts();
    const bounds: WaveBounds = {
      minProj: 0,
      maxProj: 10,
      minPerp: -5,
      maxPerp: 5,
    };
    const topology = countMeshTopology(wavefronts);
    const mesh = buildMeshData(wavefronts, 100, 1, 0, bounds);

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

  it("uses stepIndices for phase and computes coverage quad corners", () => {
    const wavefronts = makeTwoRowWavefronts();
    const bounds: WaveBounds = {
      minProj: 0,
      maxProj: 10,
      minPerp: -2,
      maxPerp: 2,
    };
    const wavelength = 20;
    const k = (2 * Math.PI) / wavelength;
    const phasePerStep = 0.7;
    const phaseModel = createIndexedPhaseModel([10, 20], phasePerStep);
    const mesh = buildMeshData(
      wavefronts,
      wavelength,
      1,
      0,
      bounds,
      phaseModel,
    );

    const phaseOffsetIndex = 4;
    const firstVertexPhase = mesh.vertices[phaseOffsetIndex];
    const expectedFirstPhase = 10 * phasePerStep - k * 0;
    assert.ok(Math.abs(firstVertexPhase - expectedFirstPhase) < 1e-6);

    const secondRowFirstVertex = 3 * VERTEX_FLOATS;
    const secondRowPhase = mesh.vertices[secondRowFirstVertex + phaseOffsetIndex];
    const expectedSecondRowPhase = 20 * phasePerStep - k * 0;
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

  it("applies source step offset in phase model (skirt rebasing)", () => {
    const wavefronts = makeTwoRowWavefronts();
    const bounds: WaveBounds = {
      minProj: 0,
      maxProj: 10,
      minPerp: -2,
      maxPerp: 2,
    };
    const wavelength = 20;
    const k = (2 * Math.PI) / wavelength;
    const phasePerStep = 0.5;
    const phaseModel = createIndexedPhaseModel([5, 7], phasePerStep, -2);
    const mesh = buildMeshData(wavefronts, wavelength, 1, 0, bounds, phaseModel);

    const phaseOffsetIndex = 4;
    const firstVertexPhase = mesh.vertices[phaseOffsetIndex];
    const expectedFirstPhase = 3 * phasePerStep - k * 0;
    assert.ok(Math.abs(firstVertexPhase - expectedFirstPhase) < 1e-6);

    const secondRowFirstVertex = 3 * VERTEX_FLOATS;
    const secondRowPhase = mesh.vertices[secondRowFirstVertex + phaseOffsetIndex];
    const expectedSecondRowPhase = 5 * phasePerStep - k * 0;
    assert.ok(Math.abs(secondRowPhase - expectedSecondRowPhase) < 1e-6);
  });

  it("matches row-based topology/counts on a simple linear track", () => {
    const wavefronts: Wavefront[] = [
      [makeTwoRowWavefronts()[0][0]],
      [makeTwoRowWavefronts()[1][0]],
      [
        {
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
    const bounds: WaveBounds = {
      minProj: 0,
      maxProj: 10,
      minPerp: -2,
      maxPerp: 2,
    };
    const tracks = buildSegmentTracks(wavefronts).tracks;
    const rowTopology = countMeshTopology(wavefronts);
    const trackTopology = countMeshTopologyFromTracks(tracks);
    const rowMesh = buildMeshData(wavefronts, 100, 1, 0, bounds);
    const trackMesh = buildMeshDataFromTracks(tracks, 100, 1, 0, bounds, Math.PI);

    assert.deepEqual(trackTopology, rowTopology);
    assert.equal(trackMesh.vertexCount, rowMesh.vertexCount);
    assert.equal(trackMesh.indexCount, rowMesh.indexCount);
  });

  it("triangulates across skipped intermediate rows in a track", () => {
    const wavefronts: Wavefront[] = [
      [
        {
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
    tracksResult.tracks[0].snapshots.splice(1, 1); // keep step 0 -> 2

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
});
