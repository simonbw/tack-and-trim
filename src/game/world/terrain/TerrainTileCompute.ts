/**
 * TerrainTileCompute: GPU compute shader for generating terrain height tiles.
 *
 * Computes terrain height for each texel in a tile by:
 * 1. Converting tile coordinates to world position
 * 2. Walking the contour tree to find the deepest containing contour
 * 3. Writing the height value to the output texture
 */

import { TileCompute } from "../../../core/graphics/webgpu/virtual-texture/TileCompute";
import type { BindingsDefinition } from "../../../core/graphics/webgpu/ShaderBindings";

/**
 * Bindings for terrain tile compute shader.
 */
export const TerrainTileBindings = {
  /** Contour metadata array (ContourGPU structs) */
  contours: { type: "storage" },
  /** Control point positions for all contours (vec2f array) */
  controlPoints: { type: "storage" },
  /** Global parameters (default depth, contour count) */
  params: { type: "uniform" },
  /** Tile-specific parameters (LOD, position, size) */
  tileParams: { type: "uniform" },
  /** Output height texture (r32float) - r16float doesn't support storage write */
  output: { type: "storageTexture", format: "r32float" },
} as const satisfies BindingsDefinition;

/**
 * Shared WGSL utility functions for terrain queries.
 * Used by both tile and query compute shaders.
 */
export const TERRAIN_WGSL_UTILS = /* wgsl */ `
// ============================================================================
// Catmull-Rom Spline Evaluation
// ============================================================================

fn catmullRomSpline(p0: vec2f, p1: vec2f, p2: vec2f, p3: vec2f, t: f32) -> vec2f {
  let t2 = t * t;
  let t3 = t2 * t;

  let x = 0.5 * (
    2.0 * p1.x +
    (-p0.x + p2.x) * t +
    (2.0 * p0.x - 5.0 * p1.x + 4.0 * p2.x - p3.x) * t2 +
    (-p0.x + 3.0 * p1.x - 3.0 * p2.x + p3.x) * t3
  );

  let y = 0.5 * (
    2.0 * p1.y +
    (-p0.y + p2.y) * t +
    (2.0 * p0.y - 5.0 * p1.y + 4.0 * p2.y - p3.y) * t2 +
    (-p0.y + 3.0 * p1.y - 3.0 * p2.y + p3.y) * t3
  );

  return vec2f(x, y);
}

// ============================================================================
// Point-in-Contour Test
// ============================================================================

// Number of samples per segment for ray casting
const SAMPLES_PER_SEGMENT = 32u;

/**
 * Evaluate a point on a closed contour at parameter t (0 to 1).
 *
 * @param contourStart - Index of first control point
 * @param contourCount - Number of control points
 * @param t - Parameter along contour (0-1)
 * @return Point on contour
 */
fn evaluateContourAt(contourStart: u32, contourCount: u32, t: f32) -> vec2f {
  // Map t to segment index and local t
  let totalSegments = f32(contourCount);
  let segmentFloat = t * totalSegments;
  let segmentIndex = u32(floor(segmentFloat)) % contourCount;
  let localT = fract(segmentFloat);

  // Get control points for this segment (closed spline)
  let i = segmentIndex;
  let n = contourCount;
  let p0 = controlPoints[(contourStart + (i + n - 1u) % n)];
  let p1 = controlPoints[(contourStart + i)];
  let p2 = controlPoints[(contourStart + (i + 1u) % n)];
  let p3 = controlPoints[(contourStart + (i + 2u) % n)];

  return catmullRomSpline(p0, p1, p2, p3, localT);
}

/**
 * Ray casting point-in-polygon test for a contour.
 *
 * @param point - Point to test
 * @param contourStart - Index of first control point
 * @param contourCount - Number of control points
 * @return True if point is inside contour
 */
fn pointInContour(point: vec2f, contourStart: u32, contourCount: u32) -> bool {
  var inside = false;
  let numSamples = contourCount * SAMPLES_PER_SEGMENT;

  // SAFETY: Limit total samples to prevent GPU hang
  // With SAMPLES_PER_SEGMENT=32, this allows ~156 control points max
  let safeSamples = min(numSamples, 5000u);

  for (var i = 0u; i < safeSamples; i++) {
    let j = (i + 1u) % numSamples;

    let t1 = f32(i) / f32(numSamples);
    let t2 = f32(j) / f32(numSamples);

    let p1 = evaluateContourAt(contourStart, contourCount, t1);
    let p2 = evaluateContourAt(contourStart, contourCount, t2);

    // Ray casting: cast ray to the right and count crossings
    if ((p1.y > point.y) != (p2.y > point.y)) {
      let xIntersect = (p2.x - p1.x) * (point.y - p1.y) / (p2.y - p1.y) + p1.x;
      if (point.x < xIntersect) {
        inside = !inside;
      }
    }
  }

  return inside;
}

// ============================================================================
// Tree Traversal
// ============================================================================

/**
 * Find the deepest contour containing a point by walking the tree iteratively.
 *
 * WGSL doesn't support recursion, so we use an iterative depth-first search
 * with a manual stack.
 *
 * @param point - Point to query
 * @param nodeIndex - Root node index to start from
 * @return Height of deepest containing contour, or -1e6 if not contained
 */
fn checkContourIterative(point: vec2f, nodeIndex: u32) -> f32 {
  if (nodeIndex >= arrayLength(&contours)) {
    return -1e6;
  }

  let node = contours[nodeIndex];

  // Test if point is inside this root contour
  if (!pointInContour(point, node.controlPointStart, node.controlPointCount)) {
    return -1e6; // Not inside
  }

  // Point is inside root. Now search children iteratively.
  var deepestHeight = node.height;

  // Simple iterative tree walk: check all descendants
  // Start at this node's children and check their descendants too
  if (node.childrenStart >= 0) {
    let childStart = u32(node.childrenStart);
    let childEnd = min(childStart + node.childrenCount, arrayLength(&contours));

    // SAFETY: Limit iterations to prevent GPU hang
    let maxChildIterations = min(childEnd - childStart, 50u);

    for (var i = childStart; i < childStart + maxChildIterations; i++) {
      // Bounds check
      if (i >= arrayLength(&contours)) {
        break;
      }

      let childNode = contours[i];

      // Check if point is in this child
      if (pointInContour(point, childNode.controlPointStart, childNode.controlPointCount)) {
        deepestHeight = childNode.height;

        // Check grandchildren (one level deeper)
        if (childNode.childrenStart >= 0) {
          let grandStart = u32(childNode.childrenStart);
          let grandEnd = min(grandStart + childNode.childrenCount, arrayLength(&contours));

          // SAFETY: Limit iterations to prevent GPU hang
          let maxGrandIterations = min(grandEnd - grandStart, 50u);

          for (var j = grandStart; j < grandStart + maxGrandIterations; j++) {
            // Bounds check
            if (j >= arrayLength(&contours)) {
              break;
            }

            let grandNode = contours[j];

            if (pointInContour(point, grandNode.controlPointStart, grandNode.controlPointCount)) {
              deepestHeight = grandNode.height;
              // Phase 2: Only support 3 levels (root, child, grandchild)
              // Phase 3+ can add more levels if needed
              break;
            }
          }
        }
        break;
      }
    }
  }

  return deepestHeight;
}

/**
 * Compute terrain height at a point by finding the deepest containing contour.
 *
 * @param point - World position to query
 * @param rootCount - Number of root contours
 * @param defaultDepth - Height to return if no contour contains the point
 * @return Terrain height at the point
 */
fn computeHeightAt(point: vec2f, rootCount: u32, defaultDepth: f32) -> f32 {
  // Walk tree from each root
  // SAFETY: Limit root iterations to prevent GPU hang
  let maxRootIterations = min(rootCount, 50u);
  for (var i = 0u; i < maxRootIterations; i++) {
    let height = checkContourIterative(point, i);
    if (height > -1e5) {
      return height;
    }
  }

  // No contour contains this point
  return defaultDepth;
}
`;

/**
 * GPU compute shader for terrain tile generation.
 */
export class TerrainTileCompute extends TileCompute<
  typeof TerrainTileBindings
> {
  readonly bindings = TerrainTileBindings;

  readonly code = /* wgsl */ `
${TERRAIN_WGSL_UTILS}

// ============================================================================
// GPU Buffer Definitions
// ============================================================================

struct ContourGPU {
  controlPointStart: u32,
  controlPointCount: u32,
  height: f32,
  childrenStart: i32,      // -1 if no children
  childrenCount: u32,
  _padding: vec3u,         // Align to 16 bytes
}

struct Params {
  defaultDepth: f32,
  rootCount: u32,          // Number of root contours (for tree traversal)
  _padding: vec2u,
}

struct TileParams {
  lod: u32,
  tileX: i32,
  tileY: i32,
  tileSize: u32,
  worldTileSize: f32,
  _padding: vec3u,
}

@group(0) @binding(0) var<storage, read> contours: array<ContourGPU>;
@group(0) @binding(1) var<storage, read> controlPoints: array<vec2f>;
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(3) var<uniform> tileParams: TileParams;
@group(0) @binding(4) var output: texture_storage_2d<r32float, write>;

// ============================================================================
// Main Compute Shader
// ============================================================================

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let texSize = tileParams.tileSize;

  // Bounds check
  if (id.x >= texSize || id.y >= texSize) {
    return;
  }

  // Compute world position from tile coordinates + texel offset
  let tileWorldX = f32(tileParams.tileX) * tileParams.worldTileSize;
  let tileWorldY = f32(tileParams.tileY) * tileParams.worldTileSize;

  let texelSize = tileParams.worldTileSize / f32(texSize);
  let worldX = tileWorldX + (f32(id.x) + 0.5) * texelSize;
  let worldY = tileWorldY + (f32(id.y) + 0.5) * texelSize;
  let worldPos = vec2f(worldX, worldY);

  // Find deepest containing contour
  let height = computeHeightAt(worldPos, params.rootCount, params.defaultDepth);

  // Write to tile texture
  textureStore(output, vec2u(id.x, id.y), vec4f(height, 0.0, 0.0, 0.0));
}
`;
}
