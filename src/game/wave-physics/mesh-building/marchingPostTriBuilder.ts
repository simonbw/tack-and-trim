/**
 * Wavefront marching mesh builder with post-triangulation decimation.
 *
 * Pipeline:
 * 1) march wavefronts
 * 2) compute amplitudes + diffraction
 * 3) triangulate full mesh
 * 4) simplify by removing interior vertices from the triangulated mesh
 *
 * No engine imports — safe for use in web workers.
 */

const VERTEX_SPACING = 20; // feet per vertex
const STEP_SIZE = 10; // feet per step (deep water)
const POST_TRI_DECIMATION_TOLERANCE = DEFAULT_DECIMATION_TOLERANCE;
const POST_TRI_MAX_DECIMATION_TIME_MS = 250;
const POST_TRI_MAX_CANDIDATE_EVALUATIONS = 5000;
const POST_TRI_MAX_REMOVALS = 1000;

import type { WaveSource } from "../../world/water/WaveSource";
import type { TerrainCPUData } from "../../world/terrain/TerrainCPUData";
import type { MeshBuildBounds, WavefrontMeshData } from "./MeshBuildTypes";
import { DEFAULT_DECIMATION_TOLERANCE } from "./decimation";
import {
  applyDiffraction,
  computeAmplitudes,
  generateInitialWavefront,
  marchWavefronts,
} from "./marching";
import { computeBounds } from "./marchingBounds";
import { buildMeshData } from "./meshOutput";
import { decimateTriangulatedMesh } from "./postTriDecimation";

export function buildMarchingPostTriMesh(
  waveSource: WaveSource,
  _coastlineBounds: MeshBuildBounds | null,
  terrain: TerrainCPUData,
  _tideHeight: number,
): WavefrontMeshData {
  const wavelength = waveSource.wavelength;
  const baseDir = waveSource.direction;
  const stepSize = STEP_SIZE;
  const k = (2 * Math.PI) / wavelength;
  const phasePerStep = k * stepSize;
  const vertexSpacing = VERTEX_SPACING;

  const waveDx = Math.cos(baseDir);
  const waveDy = Math.sin(baseDir);

  const t0 = performance.now();
  const bounds = computeBounds(terrain, wavelength, waveDx, waveDy);
  const t1 = performance.now();

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
  const t2 = performance.now();

  const initialDeltaT = 1 / (firstWavefront.length - 1);
  computeAmplitudes(wavefronts, wavelength, vertexSpacing, initialDeltaT);
  applyDiffraction(
    wavefronts,
    wavelength,
    vertexSpacing,
    stepSize,
    initialDeltaT,
  );
  const t3 = performance.now();

  const totalMarchedVerts = wavefronts.reduce((prev, curr) => {
    return prev + curr.reduce((sum, segment) => sum + segment.length, 0);
  }, 0);

  const fullMesh = buildMeshData(
    wavefronts,
    wavelength,
    waveDx,
    waveDy,
    bounds,
    undefined,
    phasePerStep,
  );
  const t4 = performance.now();

  const decimated = decimateTriangulatedMesh(
    fullMesh,
    {
      tolerance: POST_TRI_DECIMATION_TOLERANCE,
      maxDecimationTimeMs: POST_TRI_MAX_DECIMATION_TIME_MS,
      maxCandidateEvaluations: POST_TRI_MAX_CANDIDATE_EVALUATIONS,
      maxRemovals: POST_TRI_MAX_REMOVALS,
    },
  );
  const mesh = decimated.meshData;
  const t5 = performance.now();

  const simplificationPercent =
    fullMesh.vertexCount > 0
      ? 100 * (1 - mesh.vertexCount / fullMesh.vertexCount)
      : 0;
  const totalBytes = mesh.vertices.byteLength + mesh.indices.byteLength;
  const memStr =
    totalBytes >= 1024 * 1024
      ? `${(totalBytes / (1024 * 1024)).toFixed(1)} MB`
      : `${(totalBytes / 1024).toFixed(1)} KB`;

  const n = (s: number, digits: number = 0) =>
    s.toLocaleString(undefined, { maximumFractionDigits: digits });
  console.log(
    [
      `[marching_posttri]`,
      `build`,
      `  splits: ${n(splits)}`,
      `  merges: ${n(merges)}`,
      `  simplification: ${n(fullMesh.vertexCount)} verts -> ${n(mesh.vertexCount)} verts (${n(simplificationPercent, 0)}% reduction)`,
      `  marched: ${n(totalMarchedVerts)} verts`,
      `final`,
      `  verts: ${n(mesh.vertexCount)}`,
      `  tris: ${n(mesh.indexCount / 3)}`,
      `  buffer: ${memStr}`,
      `post-tri decimator`,
      `  removed vertices: ${n(decimated.stats.removedVertices)}`,
      `  locked boundary: ${n(decimated.stats.lockedBoundaryVertices)}`,
      `  candidate evals: ${n(decimated.stats.candidateEvaluations)}`,
      `  stale candidates: ${n(decimated.stats.staleCandidates)}`,
      `  rejects (topology/degenerate/error): ${n(decimated.stats.rejectedTopology)} / ${n(decimated.stats.rejectedDegenerate)} / ${n(decimated.stats.rejectedError)}`,
      `  budget stop: ${decimated.stats.budgetStopReason}`,
      `timing — ${n(t5 - t0, 1)}ms total`,
      `  bounds ${n(t1 - t0, 1)}ms`,
      `  march ${n(t2 - t1, 1)}ms`,
      `  amplitudes ${n(t3 - t2, 1)}ms`,
      `  mesh ${n(t4 - t3, 1)}ms`,
      `  decimate ${n(t5 - t4, 1)}ms`,
      `  decimate-only ${n(decimated.stats.decimationTimeMs, 1)}ms`,
      `  compact-only ${n(decimated.stats.compactionTimeMs, 1)}ms`,
    ].join("\n"),
  );

  return mesh;
}
