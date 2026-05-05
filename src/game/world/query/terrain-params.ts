/**
 * Layout of the terrain channel's params SAB (Float32Array offsets).
 *
 * Writer: TerrainQueryManager (main thread).
 * Reader: query-worker terrain dispatch.
 */

/** f32 — currently unused by the kernel; reserved for future per-frame
 * params that need contour count without going through world state. */
export const TERRAIN_PARAM_CONTOUR_COUNT = 0;

/** f32 — default sea-floor depth used when no contour contains the query point. */
export const TERRAIN_PARAM_DEFAULT_DEPTH = 1;

export const TERRAIN_PARAM_COUNT = 2;
