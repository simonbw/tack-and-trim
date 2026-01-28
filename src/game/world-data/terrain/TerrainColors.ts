/**
 * Terrain color utilities (stub for editor compatibility).
 */

/**
 * Get the color for a terrain height (for editor visualization).
 * @param height Terrain height in feet
 * @returns Hex color value based on height
 */
export function getTerrainHeightColor(height: number): number {
  if (height < -20) {
    // Deep water (dark blue)
    return 0x1a3a52;
  } else if (height < -5) {
    // Medium water (blue)
    return 0x2a5a7a;
  } else if (height < 0) {
    // Shallow water (light blue)
    return 0x4a8aaa;
  } else if (height < 2) {
    // Shore/sand (tan)
    return 0xd4b896;
  } else if (height < 10) {
    // Low land (light green)
    return 0x8db87c;
  } else if (height < 30) {
    // Hills (green)
    return 0x6a9c5a;
  } else {
    // Mountains (gray)
    return 0x8a8a8a;
  }
}
