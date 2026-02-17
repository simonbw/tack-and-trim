/**
 * Shared constants for terrain simulation.
 * These are used by both TypeScript code and WGSL shaders.
 */

// Tile configuration (match water/wind patterns)
export const TERRAIN_TILE_SIZE = 64; // ft per tile
export const TERRAIN_TILE_RESOLUTION = 128; // pixels per tile

// Height normalization
export const MAX_TERRAIN_HEIGHT = 20; // ft (for GPU normalization)

// CPU pre-sampling resolution for Catmull-Rom splines
export const SAMPLES_PER_SEGMENT = 32; // Samples per control point pair (evaluated on CPU)

// Contour limits
export const MAX_CONTOURS = 128; // Maximum number of contours
export const MAX_VERTICES = 8192; // Maximum total pre-sampled vertices across all contours
export const MAX_CHILDREN = 512; // Maximum total children across all contours (for tree structure)

// Default terrain parameters
export const DEFAULT_DEPTH = -200; // ft - deep ocean baseline

// Shallow water threshold for rendering
export const SHALLOW_WATER_THRESHOLD = 1.5; // ft - depth for sand/water blending

/**
 * WGSL code snippet defining terrain constants.
 * Interpolate this into shaders that need terrain parameters.
 */
export const TERRAIN_CONSTANTS_WGSL = /*wgsl*/ `
const PI: f32 = 3.14159265359;
const MAX_TERRAIN_HEIGHT: f32 = ${MAX_TERRAIN_HEIGHT}.0;
const SHALLOW_WATER_THRESHOLD: f32 = ${SHALLOW_WATER_THRESHOLD};
const MAX_CONTOURS: u32 = ${MAX_CONTOURS}u;
const DEFAULT_DEPTH: f32 = ${DEFAULT_DEPTH}.0;
`;
