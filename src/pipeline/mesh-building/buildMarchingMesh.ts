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

const TEST_MODE = process.env.NODE_ENV === "test";

import type { TerrainCPUData } from "../../game/world/terrain/TerrainCPUData";
import type { WaveSource } from "../../game/world/water/WaveSource";
import type { MeshBuildBounds, WavefrontMeshData } from "./MeshBuildTypes";
import {
  DEFAULT_MESH_BUILD_CONFIG,
  resolveMeshBuildConfig,
  TEST_MESH_BUILD_CONFIG,
} from "./meshBuildConfig";
import {
  generateInitialWavefront,
  marchWavefronts,
} from "./marching";
import { computeBounds } from "./computeBounds";
import { buildMeshDataFromTracks } from "./buildMeshDataFromTracks";

const BASE_CONFIG = TEST_MODE ? TEST_MESH_BUILD_CONFIG : DEFAULT_MESH_BUILD_CONFIG;
const RESOLVED_CONFIG = resolveMeshBuildConfig(BASE_CONFIG);
let loggedConfigOverrides = false;

export function buildMarchingMesh(
  waveSource: WaveSource,
  _coastlineBounds: MeshBuildBounds | null,
  terrain: TerrainCPUData,
  _tideHeight: number,
): WavefrontMeshData {
  const config = RESOLVED_CONFIG.config;
  if (!loggedConfigOverrides && RESOLVED_CONFIG.overrides.length > 0) {
    loggedConfigOverrides = true;
    console.log(
      `[marching] mesh config overrides:\n  ${RESOLVED_CONFIG.overrides.join("\n  ")}`,
    );
  }
  const wavelength = waveSource.wavelength;
  const baseDir = waveSource.direction;
  const stepSize = config.resolution.stepSizeFt;
  const k = (2 * Math.PI) / wavelength;
  const phasePerStep = k * stepSize;
  const vertexSpacing = config.resolution.vertexSpacingFt;

  const waveDx = Math.cos(baseDir);
  const waveDy = Math.sin(baseDir);

  let t0 = performance.now();
  const bounds = computeBounds(terrain, wavelength, waveDx, waveDy, config.bounds);
  let t1 = performance.now();
  const firstWavefront = generateInitialWavefront(
    bounds,
    vertexSpacing,
    waveDx,
    waveDy,
    wavelength,
  );
  const numRays = firstWavefront.t.length;
  const domainLength = bounds.maxProj - bounds.minProj;
  const domainWidth = bounds.maxPerp - bounds.minPerp;
  const estimatedSteps = Math.ceil(domainLength / stepSize);
  const nEarly = (s: number, digits: number = 0) =>
    s.toLocaleString(undefined, { maximumFractionDigits: digits });
  console.log(
    [
      `[marching] domain`,
      `  rays: ${nEarly(numRays)}`,
      `  domain: ${nEarly(domainLength, 0)}ft × ${nEarly(domainWidth, 0)}ft`,
      `  estimated steps: ${nEarly(estimatedSteps)} (step size: ${stepSize}ft)`,
      `  ray×step estimate: ${nEarly(numRays * estimatedSteps)}`,
    ].join("\n"),
  );
  const {
    tracks,
    marchedVerticesBeforeDecimation,
    removedSegmentSnapshots,
    removedVertices,
    splits,
    merges,
    amplitudeMs,
    diffractionMs,
    compactMs,
    turnClampCount,
    totalRefractions,
  } = marchWavefronts(
    firstWavefront,
    waveDx,
    waveDy,
    stepSize,
    vertexSpacing,
    bounds,
    terrain,
    wavelength,
    config,
  );
  let t2 = performance.now();

  const mesh = buildMeshDataFromTracks(
    tracks,
    wavelength,
    waveDx,
    waveDy,
    bounds,
    phasePerStep,
  );
  let t3 = performance.now();
  const totalMs = t3 - t0;
  const stageMs = {
    bounds: t1 - t0,
    march: Math.max(0, t2 - t1 - amplitudeMs - diffractionMs - compactMs),
    amplitude: amplitudeMs,
    diffraction: diffractionMs,
    compact: compactMs,
    decimate: 0,
    mesh: t3 - t2,
  };

  const totalMarchedVerts = Math.max(1, marchedVerticesBeforeDecimation);
  const decimationPercent = 100 * (1 - mesh.vertexCount / totalMarchedVerts);
  const marchedStepCount =
    tracks.reduce((maxStep, track) => {
      if (track.snapshots.length === 0) return maxStep;
      const trackLastStep =
        track.snapshots[track.snapshots.length - 1].sourceStepIndex + 1;
      return Math.max(maxStep, trackLastStep);
    }, 0);
  const totalBytes = mesh.vertices.byteLength + mesh.indices.byteLength;
  const memStr =
    totalBytes >= 1024 * 1024
      ? `${(totalBytes / (1024 * 1024)).toFixed(1)} MB`
      : `${(totalBytes / 1024).toFixed(1)} KB`;

  const n = (s: number, digits: number = 0) =>
    s.toLocaleString(undefined, { maximumFractionDigits: digits });
  console.log(
    [
      `[marching]`,
      `  actual wavefront steps: ${n(marchedStepCount)}`,
      `build`,
      `  splits: ${n(splits)}`,
      `  merges: ${n(merges)}`,
      `  refraction clamps: ${n(turnClampCount)} / ${n(totalRefractions)} (${totalRefractions > 0 ? n((100 * turnClampCount) / totalRefractions, 1) : 0}%)`,
      `  simplification: ${n(totalMarchedVerts)} verts -> ${n(mesh.vertexCount)} verts (${n(decimationPercent, 0)}% reduction)`,
      `  decimation removed: ${n(removedVertices)} verts, ${n(removedSegmentSnapshots)} snapshots`,
      `final`,
      `  verts: ${n(mesh.vertexCount)}`,
      `  tris: ${n(mesh.indexCount / 3)}`,
      `  buffer: ${memStr}`,
      `timing — ${n(totalMs, 1)}ms total`,
      `  bounds ${n(stageMs.bounds, 1)}ms`,
      `  march ${n(stageMs.march, 1)}ms`,
      `  amplitude ${n(stageMs.amplitude, 1)}ms`,
      `  diffraction ${n(stageMs.diffraction, 1)}ms`,
      `  compact ${n(stageMs.compact, 1)}ms`,
      `  decimate ${n(stageMs.decimate, 1)}ms`,
      `  mesh ${n(stageMs.mesh, 1)}ms`,
    ].join("\n"),
  );

  return mesh;
}
