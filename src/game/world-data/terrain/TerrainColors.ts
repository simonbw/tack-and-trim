/**
 * Terrain height color utilities.
 *
 * Provides consistent height-based coloring for terrain visualization
 * in both the editor and game debug modes.
 */

/**
 * Get terrain color based on height.
 *
 * - Height = 0: Green (shore level)
 * - Height < 0: Blue gradient (darker for deeper)
 * - Height > 0: Brown/tan gradient (lighter for higher)
 *
 * @param height - Terrain height in world units
 * @returns RGB color as a 24-bit integer (0xRRGGBB)
 */
export function getTerrainHeightColor(height: number): number {
  if (height === 0) {
    // Shore level - green
    return 0x44aa44;
  } else if (height < 0) {
    // Underwater - blue, darker for deeper
    const t = Math.min(-height / 50, 1);
    const r = Math.round(50 * (1 - t));
    const g = Math.round(100 + 50 * (1 - t));
    const b = Math.round(180 + 75 * (1 - t));
    return (r << 16) | (g << 8) | b;
  } else {
    // Above water - brown/tan, lighter for higher
    const t = Math.min(height / 20, 1);
    const r = Math.round(140 + 60 * t);
    const g = Math.round(100 + 40 * t);
    const b = Math.round(60 + 20 * t);
    return (r << 16) | (g << 8) | b;
  }
}
