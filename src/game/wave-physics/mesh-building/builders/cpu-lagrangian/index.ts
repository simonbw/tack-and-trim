/**
 * CPU Lagrangian wavefront marching mesh builder.
 *
 * Advances a polyline of wave points step-by-step from the upwind edge of the
 * simulation domain. Each point can split into multiple points or remove itself
 * (e.g. when out of bounds). The resulting wavefronts are triangulated into a
 * mesh.
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
import { generateInitialWavefront, marchWavefronts } from "./marching";
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
  const vertexSpacing = wavelength;

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
    bounds,
    terrain,
    wavelength,
  );
  return buildMeshData(wavefronts, wavelength, waveDx, waveDy);
}
