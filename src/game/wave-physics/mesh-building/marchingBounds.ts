import type { TerrainDataForWorker } from "./MeshBuildTypes";
import type { WaveBounds } from "./marchingTypes";

/** Number of 32-bit values per contour (must match LandMass.FLOATS_PER_CONTOUR) */
const FLOATS_PER_CONTOUR = 13;

/** Margin in wavelengths for each side of the domain */
const UPWAVE_MARGIN = 10;
const DOWNWAVE_MARGIN = 80;
const CROSSWAVE_MARGIN = 40;

/** Absolute minimum margin in feet */
const MIN_MARGIN = 2000;

/**
 * Compute a wave-aligned bounding box from root terrain contours.
 * Projects root contour bounding boxes onto the wave direction to find
 * the upwave, downwave, wave-left, and wave-right extents.
 *
 * Margins are asymmetric: small upwave (waves arrive from there), large
 * downwave (refraction, diffraction, and shadows develop there), medium
 * crosswave (lateral spreading).
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

  const upwave = Math.max(MIN_MARGIN, wavelength * UPWAVE_MARGIN);
  const downwave = Math.max(MIN_MARGIN, wavelength * DOWNWAVE_MARGIN);
  const crosswave = Math.max(MIN_MARGIN, wavelength * CROSSWAVE_MARGIN);
  return {
    minProj: minProj - upwave,
    maxProj: maxProj + downwave,
    minPerp: minPerp - crosswave,
    maxPerp: maxPerp + crosswave,
  };
}
