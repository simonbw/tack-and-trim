import type { TerrainDataForWorker } from "../../MeshBuildTypes";
import { computeTerrainHeight } from "../../../cpu/terrainHeight";
import type { WaveBounds, WavePoint } from "./types";

/**
 * Generate the initial wavefront: a line of evenly-spaced points along the
 * upwave edge of the domain, perpendicular to the wave direction.
 */
export function generateInitialWavefront(
  bounds: WaveBounds,
  vertexSpacing: number,
  waveDx: number,
  waveDy: number,
): WavePoint[] {
  const perpDx = -waveDy;
  const perpDy = waveDx;
  const wavefrontWidth = bounds.maxPerp - bounds.minPerp;

  const numVertices = Math.max(
    3,
    Math.ceil(wavefrontWidth / vertexSpacing) + 1,
  );
  const wavefront: WavePoint[] = [];
  for (let i = 0; i < numVertices; i++) {
    const t = i / (numVertices - 1);
    const perpPos = bounds.minPerp + t * wavefrontWidth;
    wavefront.push({
      x: bounds.minProj * waveDx + perpPos * perpDx,
      y: bounds.minProj * waveDy + perpPos * perpDy,
      t,
    });
  }
  return wavefront;
}

/**
 * March wavefronts step-by-step until all points leave the domain.
 * Each point advances perpendicular to the local wavefront at a speed
 * determined by the water depth (refraction/shoaling).
 */
export function marchWavefronts(
  firstWavefront: WavePoint[],
  waveDx: number,
  waveDy: number,
  stepSize: number,
  bounds: WaveBounds,
  terrain: TerrainDataForWorker,
  wavelength: number,
): WavePoint[][] {
  const perpDx = -waveDy;
  const perpDy = waveDx;
  const wavefronts: WavePoint[][] = [firstWavefront];
  const k = (2 * Math.PI) / wavelength;

  function getNextWavePoints(
    point: WavePoint,
    left: WavePoint | null,
    right: WavePoint | null,
  ): WavePoint[] {
    // Compute local wavefront tangent from neighbors
    let tx: number, ty: number;
    if (left && right) {
      tx = right.x - left.x;
      ty = right.y - left.y;
    } else if (left) {
      tx = point.x - left.x;
      ty = point.y - left.y;
    } else if (right) {
      tx = right.x - point.x;
      ty = right.y - point.y;
    } else {
      // Solo point — use base wave perpendicular as tangent
      tx = perpDx;
      ty = perpDy;
    }

    // Normalize tangent
    const tLen = Math.sqrt(tx * tx + ty * ty);
    if (tLen < 1e-10) {
      tx = perpDx;
      ty = perpDy;
    } else {
      tx /= tLen;
      ty /= tLen;
    }

    // Advance direction: perpendicular to tangent, facing wave propagation
    let advDx = -ty;
    let advDy = tx;
    if (advDx * waveDx + advDy * waveDy < 0) {
      advDx = -advDx;
      advDy = -advDy;
    }

    // Water depth from terrain (negative height = underwater)
    const terrainH = computeTerrainHeight(point.x, point.y, terrain);
    const waterDepth = -terrainH;
    if (waterDepth <= 0) return [];

    // Phase speed ratio: c/c_deep = sqrt(tanh(k * h))
    const speedFactor = Math.sqrt(Math.tanh(k * waterDepth));
    const localStep = stepSize * speedFactor;

    const nx = point.x + advDx * localStep;
    const ny = point.y + advDy * localStep;

    // Bounds check in wave-aligned coordinates
    const proj = nx * waveDx + ny * waveDy;
    const perp = nx * perpDx + ny * perpDy;
    if (
      proj < bounds.minProj ||
      proj > bounds.maxProj ||
      perp < bounds.minPerp ||
      perp > bounds.maxPerp
    )
      return [];

    return [{ x: nx, y: ny, t: point.t }];
  }

  for (;;) {
    const prev = wavefronts[wavefronts.length - 1];
    const next: WavePoint[] = [];

    for (let i = 0; i < prev.length; i++) {
      const left = i > 0 ? prev[i - 1] : null;
      const right = i < prev.length - 1 ? prev[i + 1] : null;
      const points = getNextWavePoints(prev[i], left, right);
      for (const p of points) next.push(p);
    }

    if (next.length === 0) break;
    wavefronts.push(next);
  }

  return wavefronts;
}
