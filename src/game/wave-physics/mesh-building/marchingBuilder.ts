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
const STEP_SIZE = 0.5; // step size in wavelengths

import type { WaveSource } from "../../world/water/WaveSource";
import type {
  MeshBuildBounds,
  TerrainDataForWorker,
  WavefrontMeshData,
} from "./MeshBuildTypes";
import { decimateWavefronts } from "./decimation";
import {
  applyDiffraction,
  computeAmplitudes,
  generateInitialWavefront,
  marchWavefronts,
} from "./marching";
import { computeBounds } from "./marchingBounds";
import { buildMeshData } from "./meshOutput";

export function buildMarchingMesh(
  waveSource: WaveSource,
  _coastlineBounds: MeshBuildBounds | null,
  terrain: TerrainDataForWorker,
  _tideHeight: number,
): WavefrontMeshData {
  const wavelength = waveSource.wavelength;
  const baseDir = waveSource.direction;
  const stepSize = STEP_SIZE * waveSource.wavelength;
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
  const { wavefronts, splits, merges } = marchWavefronts(
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
  const initialDeltaT = 1 / (firstWavefront.length - 1);
  computeAmplitudes(
    wavefronts,
    terrain,
    wavelength,
    vertexSpacing,
    initialDeltaT,
  );
  applyDiffraction(
    wavefronts,
    wavelength,
    vertexSpacing,
    stepSize,
    initialDeltaT,
  );
  let t3 = performance.now();
  const totalMarchedVerts = wavefronts.reduce((prev, curr) => {
    return prev + curr.reduce((sum, segment) => sum + segment.length, 0);
  }, 0);
  const decimated = decimateWavefronts(wavefronts, wavelength, waveDx, waveDy);
  let t4 = performance.now();
  const mesh = buildMeshData(
    decimated.wavefronts,
    wavelength,
    waveDx,
    waveDy,
    bounds,
    decimated.stepIndices,
  );
  let t5 = performance.now();

  const decimationPercent = 100 * (1 - mesh.vertexCount / totalMarchedVerts);

  const n = (s: number, digits: number = 0) =>
    s.toLocaleString(undefined, { maximumFractionDigits: digits });
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
      `timing — ${n(t5 - t0, 1)}ms total`,
      `  bounds ${n(t1 - t0, 1)}ms`,
      `  march ${n(t2 - t1, 1)}ms`,
      `  amplitudes ${n(t3 - t2, 1)}ms`,
      `  decimate ${n(t4 - t3, 1)}ms`,
      `  mesh ${n(t5 - t4, 1)}ms`,
    ].join("\n"),
  );

  return mesh;
}
