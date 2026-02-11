/**
 * CPU Lagrangian wavefront marching mesh builder.
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

import type { WaveSource } from "../../../../world/water/WaveSource";
import type {
  MeshBuildBounds,
  TerrainDataForWorker,
  WavefrontMeshData,
} from "../../MeshBuildTypes";
import { computeBounds } from "./bounds";
import {
  computeAmplitudes,
  generateInitialWavefront,
  marchWavefronts,
} from "./marching";
import { buildMeshData } from "./meshOutput";

export function buildCpuLagrangianMesh(
  waveSource: WaveSource,
  _coastlineBounds: MeshBuildBounds | null,
  terrain: TerrainDataForWorker,
  _tideHeight: number,
): WavefrontMeshData {
  const wavelength = waveSource.wavelength;
  const baseDir = waveSource.direction;
  const stepSize = wavelength / 2;
  const vertexSpacing = wavelength / 4;

  const waveDx = Math.cos(baseDir);
  const waveDy = Math.sin(baseDir);

  const bounds = computeBounds(terrain, wavelength, waveDx, waveDy);
  const firstWavefront = generateInitialWavefront(
    bounds,
    vertexSpacing,
    waveDx,
    waveDy,
  );
  const wavefronts = marchWavefronts(
    firstWavefront,
    waveDx,
    waveDy,
    stepSize,
    vertexSpacing,
    bounds,
    terrain,
    wavelength,
  );
  computeAmplitudes(wavefronts, terrain, wavelength, vertexSpacing);
  return buildMeshData(wavefronts, wavelength, waveDx, waveDy, bounds);
}
