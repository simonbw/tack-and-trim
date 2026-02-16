/**
 * Wavefront marching mesh builder.
 *
 * Traces independent wave rays from the upwave edge of the simulation domain.
 * Each ray carries its own propagation direction, which is updated at each step
 * via Snell's law (turning toward shallower water based on the local depth
 * gradient). The set of rays at each step forms a wavefront, which is
 * triangulated into a mesh for rendering and queries.
 *
 * Key properties:
 * - Rays are independent — no inter-ray coupling for direction
 * - Refraction emerges naturally from depth-gradient-driven turning
 * - Rays can refract past 90° (wrapping around headlands)
 * - Rays passing over terrain lose energy gradually (no hard cutoffs)
 * - Shoaling increases amplitude in shallow water
 * - A merge pass collapses converging rays to prevent degenerate geometry
 *
 * No engine imports — safe for use in web workers.
 */

const VERTEX_SPACING = 20; // feet per vertex
const STEP_SIZE = 10; // feet per step (deep water)

import type { WaveSource } from "../../world/water/WaveSource";
import type { TerrainCPUData } from "../../world/terrain/TerrainCPUData";
import type { MeshBuildBounds, WavefrontMeshData } from "./MeshBuildTypes";
import { decimateWavefronts } from "./decimation";
import { generateInitialWavefront, marchWavefronts } from "./marching";
import { computeBounds } from "./marchingBounds";
import { buildMeshData, countMeshTopology } from "./meshOutput";

export interface MeshBuildProfile {
  totalMs: number;
  stageMs: {
    bounds: number;
    march: number;
    amplitude: number;
    diffraction: number;
    decimate: number;
    mesh: number;
  };
  decimationCounts: {
    verticesBefore: number;
    verticesAfter: number;
    trianglesBefore: number;
    trianglesAfter: number;
  };
}

export function buildMarchingMesh(
  waveSource: WaveSource,
  _coastlineBounds: MeshBuildBounds | null,
  terrain: TerrainCPUData,
  _tideHeight: number,
  profile?: MeshBuildProfile,
): WavefrontMeshData {
  const wavelength = waveSource.wavelength;
  const baseDir = waveSource.direction;
  const stepSize = STEP_SIZE;
  const k = (2 * Math.PI) / wavelength;
  const phasePerStep = k * stepSize;
  const vertexSpacing = VERTEX_SPACING;

  const waveDx = Math.cos(baseDir);
  const waveDy = Math.sin(baseDir);

  let t0 = performance.now();
  const bounds = computeBounds(terrain, wavelength, waveDx, waveDy);
  let t1 = performance.now();
  const firstWavefront = generateInitialWavefront(
    bounds,
    vertexSpacing,
    waveDx,
    waveDy,
  );
  const { wavefronts, splits, merges, amplitudeMs, diffractionMs } =
    marchWavefronts(
      firstWavefront,
      waveDx,
      waveDy,
      stepSize,
      vertexSpacing,
      bounds,
      terrain,
      wavelength,
    );
  let t2 = performance.now();
  const totalMarchedVerts = wavefronts.reduce((prev, curr) => {
    return prev + curr.reduce((sum, segment) => sum + segment.t.length, 0);
  }, 0);
  const decimated = decimateWavefronts(
    wavefronts,
    wavelength,
    waveDx,
    waveDy,
    undefined,
    phasePerStep,
  );
  let t3 = performance.now();
  const mesh = buildMeshData(
    decimated.wavefronts,
    wavelength,
    waveDx,
    waveDy,
    bounds,
    decimated.stepIndices,
    phasePerStep,
  );
  let t4 = performance.now();
  const totalMs = t4 - t0;
  const stageMs = {
    bounds: t1 - t0,
    march: Math.max(0, t2 - t1 - amplitudeMs - diffractionMs),
    amplitude: amplitudeMs,
    diffraction: diffractionMs,
    decimate: t3 - t2,
    mesh: t4 - t3,
  };

  const decimationPercent = 100 * (1 - mesh.vertexCount / totalMarchedVerts);
  const totalBytes = mesh.vertices.byteLength + mesh.indices.byteLength;
  const memStr =
    totalBytes >= 1024 * 1024
      ? `${(totalBytes / (1024 * 1024)).toFixed(1)} MB`
      : `${(totalBytes / 1024).toFixed(1)} KB`;

  const n = (s: number, digits: number = 0) =>
    s.toLocaleString(undefined, { maximumFractionDigits: digits });
  if (profile) {
    const preDecimationTopology = countMeshTopology(wavefronts);
    profile.totalMs = totalMs;
    profile.stageMs = stageMs;
    profile.decimationCounts = {
      verticesBefore: preDecimationTopology.vertexCount,
      verticesAfter: mesh.vertexCount,
      trianglesBefore: preDecimationTopology.triangleCount,
      trianglesAfter: mesh.indexCount / 3,
    };
  } else {
    console.log(
      [
        `[marching]`,
        `build`,
        `  splits: ${n(splits)}`,
        `  merges: ${n(merges)}`,
        `  simplification: ${n(totalMarchedVerts)} verts -> ${n(mesh.vertexCount)} verts (${n(decimationPercent, 0)}% reduction)`,
        `final`,
        `  verts: ${n(mesh.vertexCount)}`,
        `  tris: ${n(mesh.indexCount / 3)}`,
        `  buffer: ${memStr}`,
        `timing — ${n(totalMs, 1)}ms total`,
        `  bounds ${n(stageMs.bounds, 1)}ms`,
        `  march ${n(stageMs.march, 1)}ms`,
        `  amplitude ${n(stageMs.amplitude, 1)}ms`,
        `  diffraction ${n(stageMs.diffraction, 1)}ms`,
        `  decimate ${n(stageMs.decimate, 1)}ms`,
        `  mesh ${n(stageMs.mesh, 1)}ms`,
      ].join("\n"),
    );
  }

  return mesh;
}
