import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { TerrainCPUData } from "../../../game/world/terrain/TerrainCPUData";
import type { WaveSource } from "../../../game/world/water/WaveSource";
import { buildMarchingMesh } from "../buildMarchingMesh";

function buildOpenOceanTerrain(defaultDepth: number = -200): TerrainCPUData {
  return {
    vertexData: new Float32Array(0),
    contourData: new ArrayBuffer(0),
    childrenData: new Uint32Array(0),
    contourCount: 0,
    defaultDepth,
  };
}

function hashView(view: { buffer: ArrayBufferLike; byteOffset: number; byteLength: number }) {
  const bytes = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  return createHash("sha256").update(bytes).digest("hex");
}

describe("buildMarchingMesh snapshot", () => {
  it("matches expected open-ocean mesh snapshot", () => {
    const waveSource: WaveSource = {
      wavelength: 120,
      direction: Math.PI / 3,
      amplitude: 1,
      sourceDist: 0,
      sourceOffsetX: 0,
      sourceOffsetY: 0,
    };
    const terrain = buildOpenOceanTerrain();

    const mesh = buildMarchingMesh(waveSource, null, terrain, 0);
    const vertexHash = hashView(mesh.vertices);
    const indexHash = hashView(mesh.indices);

    assert.equal(mesh.vertexCount, 34);
    assert.equal(mesh.indexCount, 126);
    assert.equal(
      vertexHash,
      "a36fe514a23ecc6a9072b872cbb4d81ccf4f5a1e6273f60f1e403bdad504bcd0",
    );
    assert.equal(
      indexHash,
      "e0d22344f5eae5ff70da69ea8666bc98e00367326dd60e8467d16d5b4caae3f7",
    );
  });
});
