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
 * Each point produces zero or more points in the next wavefront via flatMap.
 */
export function marchWavefronts(
  firstWavefront: WavePoint[],
  waveDx: number,
  waveDy: number,
  stepSize: number,
  bounds: WaveBounds,
): WavePoint[][] {
  const perpDx = -waveDy;
  const perpDy = waveDx;
  const wavefronts: WavePoint[][] = [firstWavefront];

  function getNextWavePoints(point: WavePoint): WavePoint[] {
    const nx = point.x + waveDx * stepSize;
    const ny = point.y + waveDy * stepSize;
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
    const next = prev.flatMap(getNextWavePoints);
    if (next.length === 0) break;
    wavefronts.push(next);
  }

  return wavefronts;
}
