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

// IDW grid for fast boundary distance lookups
export const IDW_GRID_SIZE = 32; // 32×32 grid per contour
export const IDW_GRID_CELLS = IDW_GRID_SIZE * IDW_GRID_SIZE; // 256
export const IDW_GRID_CELL_STARTS = IDW_GRID_CELLS + 1; // 257 (prefix-sum sentinel)
export const MAX_IDW_DATA = 25165824; // 24M u32s (96MB) for all IDW grid data
export const MAX_IDW_CONTOURS = 32; // Max contours in one IDW blend (1 parent + 31 children)

// Default terrain parameters
export const DEFAULT_DEPTH = -300; // ft - deep ocean baseline

// Shallow water threshold for rendering
export const SHALLOW_WATER_THRESHOLD = 1.5; // ft - depth for sand/water blending
