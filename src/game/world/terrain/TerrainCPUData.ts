/**
 * Terrain data in a CPU-readable format.
 *
 * This is the subset of terrain data needed for CPU-side computation
 * (e.g., in web workers where GPU shaders are unavailable). The fields
 * mirror the packed terrain GPU buffer layout but are stored as plain
 * typed arrays readable from any context.
 *
 * Produced by `buildTerrainGPUData()` in LandMass.ts (which returns a
 * superset of this interface).
 */
export interface TerrainCPUData {
  /** Pre-sampled polygon vertices (2 floats per vertex) */
  vertexData: Float32Array;
  /** Contour metadata (13 u32 per contour, mixed u32/f32 types) */
  contourData: ArrayBuffer;
  /** Children indices */
  childrenData: Uint32Array;
  /** Number of contours */
  contourCount: number;
  /** Default ocean floor depth */
  defaultDepth: number;
}
