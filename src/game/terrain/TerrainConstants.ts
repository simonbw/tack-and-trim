/**
 * Shared constants for terrain simulation.
 * These are used by both TypeScript code and WGSL shaders.
 */

// Tile configuration (match water/wind patterns)
export const TERRAIN_TILE_SIZE = 64; // ft per tile
export const TERRAIN_TILE_RESOLUTION = 128; // pixels per tile

// Render texture size (reduced from 512 for performance)
export const TERRAIN_TEXTURE_SIZE = 256; // For rendering

// Height normalization
export const MAX_TERRAIN_HEIGHT = 20; // ft (for GPU normalization)

// Catmull-Rom subdivision (reduced from 16 for performance)
export const SPLINE_SUBDIVISIONS = 8; // Segments per control point pair

// Default land mass parameters
export const DEFAULT_PEAK_HEIGHT = 5; // ft
export const DEFAULT_BEACH_WIDTH = 20; // ft
export const DEFAULT_HILL_FREQUENCY = 0.02; // noise spatial scale
export const DEFAULT_HILL_AMPLITUDE = 0.3; // fraction of peak height

// Shallow water threshold for rendering
export const SHALLOW_WATER_THRESHOLD = 1.5; // ft - depth for sand/water blending

/**
 * WGSL code snippet defining terrain constants.
 * Interpolate this into shaders that need terrain parameters.
 */
export const TERRAIN_CONSTANTS_WGSL = /*wgsl*/ `
const PI: f32 = 3.14159265359;
const MAX_TERRAIN_HEIGHT: f32 = ${MAX_TERRAIN_HEIGHT}.0;
const SPLINE_SUBDIVISIONS: u32 = ${SPLINE_SUBDIVISIONS}u;
const SHALLOW_WATER_THRESHOLD: f32 = ${SHALLOW_WATER_THRESHOLD};
`;
