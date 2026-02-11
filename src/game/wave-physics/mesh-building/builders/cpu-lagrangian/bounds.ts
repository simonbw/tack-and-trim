import type { TerrainDataForWorker } from "../../MeshBuildTypes";
import type { WaveBounds } from "./types";

/** Number of 32-bit values per contour (must match LandMass.FLOATS_PER_CONTOUR) */
const FLOATS_PER_CONTOUR = 13;

/**
 * Compute a wave-aligned bounding box from root terrain contours.
 * Projects root contour bounding boxes onto the wave direction to find
 * the upwave, downwave, wave-left, and wave-right extents.
 */
export function computeBounds(
  terrain: TerrainDataForWorker,
  wavelength: number,
  waveDx: number,
  waveDy: number,
): WaveBounds {
  const perpDx = -waveDy;
  const perpDy = waveDx;
  const view = new DataView(terrain.contourData);

  let minProj = Infinity;
  let maxProj = -Infinity;
  let minPerp = Infinity;
  let maxPerp = -Infinity;

  for (let ci = 0; ci < terrain.contourCount; ci++) {
    const byteBase = ci * FLOATS_PER_CONTOUR * 4;
    const depth = view.getUint32(byteBase + 16, true);
    if (depth !== 0) continue; // only root contours

    const bMinX = view.getFloat32(byteBase + 32, true);
    const bMinY = view.getFloat32(byteBase + 36, true);
    const bMaxX = view.getFloat32(byteBase + 40, true);
    const bMaxY = view.getFloat32(byteBase + 44, true);

    // Project all 4 bbox corners onto wave direction
    for (const [cx, cy] of [
      [bMinX, bMinY],
      [bMaxX, bMinY],
      [bMaxX, bMaxY],
      [bMinX, bMaxY],
    ]) {
      const proj = cx * waveDx + cy * waveDy;
      const perp = cx * perpDx + cy * perpDy;
      if (proj < minProj) minProj = proj;
      if (proj > maxProj) maxProj = proj;
      if (perp < minPerp) minPerp = perp;
      if (perp > maxPerp) maxPerp = perp;
    }
  }

  if (minProj === Infinity) {
    return { minProj: -500, maxProj: 500, minPerp: -500, maxPerp: 500 };
  }

  const margin = Math.max(2000, wavelength * 20);
  return {
    minProj: minProj - margin,
    maxProj: maxProj + margin,
    minPerp: minPerp - margin,
    maxPerp: maxPerp + margin,
  };
}
