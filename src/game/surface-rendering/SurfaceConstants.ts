/**
 * Integer-pixel margin around the screen for the surface-rendering textures
 * (terrain height, water height, wave field, boat air, modifier, wetness).
 *
 * All surface textures are sized (screenWidth + 2*margin) × (screenHeight +
 * 2*margin). Screen pixel (i, j) maps to texture texel (i + margin, j +
 * margin) — an integer offset, no scaling. Keeping the two grids exactly
 * aligned means downstream passes can point-sample the water height at the
 * fragment's exact pixel, which eliminates the linear-filter halo at sharp
 * discontinuities (most visibly the boat outline).
 *
 * The margin itself provides:
 *   • Finite-difference normal computation in WaterFilter/TerrainComposite
 *     valid samples past the screen edge (~4 pixels needed).
 *   • Wetness reprojection a budget of off-screen data to pull from when the
 *     camera pans. Beyond the margin, the wetness shader falls back to the
 *     "new area entering viewport" initialization — still correct, just
 *     without temporal smoothing across the reset.
 */
export const SURFACE_TEXTURE_MARGIN = 32;
