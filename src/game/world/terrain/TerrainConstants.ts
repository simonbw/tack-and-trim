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

// Default terrain parameters
export const DEFAULT_DEPTH = -200; // ft - deep ocean baseline

// Shallow water threshold for rendering
export const SHALLOW_WATER_THRESHOLD = 1.5; // ft - depth for sand/water blending
