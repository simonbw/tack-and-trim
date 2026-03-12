/**
 * Shared constants for terrain simulation.
 * These are used by both TypeScript code and WGSL shaders.
 */

// CPU pre-sampling resolution for Catmull-Rom splines
export const SAMPLES_PER_SEGMENT = 16; // Samples per control point pair (evaluated on CPU)

// Contour limits
export const MAX_CONTOURS = 4096; // Maximum number of contours
export const MAX_VERTICES = 524288; // Maximum total pre-sampled vertices across all contours
export const MAX_CHILDREN = 8192; // Maximum total children across all contours (for tree structure)

// Containment grid for fast inside/outside tests
export const CONTAINMENT_GRID_SIZE = 64; // 64x64 grid per contour
export const CONTAINMENT_GRID_CELLS =
  CONTAINMENT_GRID_SIZE * CONTAINMENT_GRID_SIZE; // 4096 cells
export const CONTAINMENT_GRID_U32S_PER_CONTOUR = CONTAINMENT_GRID_CELLS / 16; // 256 u32s (2 bits per cell, 16 cells per u32)

// Default terrain parameters
export const DEFAULT_DEPTH = -300; // ft - deep ocean baseline

// Shallow water threshold for rendering
export const SHALLOW_WATER_THRESHOLD = 1.5; // ft - depth for sand/water blending
