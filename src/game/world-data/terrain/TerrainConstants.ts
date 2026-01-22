/**
 * Shared constants for terrain simulation.
 * These are used by both TypeScript code and WGSL shaders.
 */

// Tile configuration (match water/wind patterns)
export const TERRAIN_TILE_SIZE = 64; // ft per tile
export const TERRAIN_TILE_RESOLUTION = 128; // pixels per tile

// Height normalization
export const MAX_TERRAIN_HEIGHT = 20; // ft (for GPU normalization)

// Catmull-Rom subdivision (reduced from 16 for performance)
export const SPLINE_SUBDIVISIONS = 4; // Segments per control point pair

// Contour limits
export const MAX_CONTOURS = 128; // Maximum number of contours
export const MAX_CONTROL_POINTS = 2048; // Maximum total control points across all contours

// Default terrain parameters
export const DEFAULT_DEPTH = -50; // ft - deep ocean baseline
export const DEFAULT_HILL_FREQUENCY = 0.02; // noise spatial scale
export const DEFAULT_HILL_AMPLITUDE = 0.3; // height variation

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
const MAX_CONTOURS: u32 = ${MAX_CONTOURS}u;
const DEFAULT_DEPTH: f32 = ${DEFAULT_DEPTH}.0;
`;
