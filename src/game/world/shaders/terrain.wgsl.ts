/**
 * Terrain shader modules for height field computation.
 *
 * Naming convention:
 * - `fn_` prefix for function modules
 * - `struct_` prefix for struct modules
 * - `const_` prefix for constant modules
 *
 * Each module exports exactly one thing, named to match the export.
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";

// =============================================================================
// Distance Utilities
// =============================================================================

/**
 * Compute SQUARED minimum distance from point p to line segment [a, b].
 * Returns distance squared to avoid expensive sqrt in inner loops.
 * Caller should sqrt the final result if actual distance is needed.
 */
export const fn_pointToLineSegmentDistanceSq: ShaderModule = {
  code: /*wgsl*/ `
    fn pointToLineSegmentDistanceSq(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> f32 {
      let ab = b - a;
      let lengthSq = dot(ab, ab);
      if (lengthSq == 0.0) {
        let diff = p - a;
        return dot(diff, diff);
      }
      let t = clamp(dot(p - a, ab) / lengthSq, 0.0, 1.0);
      let nearest = a + t * ab;
      let diff = p - nearest;
      return dot(diff, diff);
    }
  `,
};

/**
 * Test if point p is left of line segment [a, b] (for winding number algorithm).
 * Returns positive if left, negative if right, zero if collinear.
 */
export const fn_pointLeftOfSegment: ShaderModule = {
  code: /*wgsl*/ `
    fn pointLeftOfSegment(a: vec2<f32>, b: vec2<f32>, p: vec2<f32>) -> f32 {
      return (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
    }
  `,
};

// =============================================================================
// IDW (Inverse Distance Weighting) Interpolation
// =============================================================================

/**
 * Compute IDW weight from distance.
 * Uses 1/distance weighting with minimum distance clamp.
 */
export const fn_computeIDWWeight: ShaderModule = {
  code: /*wgsl*/ `
    fn computeIDWWeight(distance: f32, minDist: f32) -> f32 {
      return 1.0 / max(distance, minDist);
    }
  `,
};

/**
 * Blend two values using IDW.
 * Returns weighted average of value1 and value2.
 */
export const fn_blendIDW: ShaderModule = {
  code: /*wgsl*/ `
    fn blendIDW(value1: f32, weight1: f32, value2: f32, weight2: f32) -> f32 {
      let totalWeight = weight1 + weight2;
      return (value1 * weight1 + value2 * weight2) / totalWeight;
    }
  `,
};

// =============================================================================
// Terrain Data Structures
// =============================================================================

/**
 * Contour data structure for terrain height computation.
 */
export const struct_ContourData: ShaderModule = {
  code: /*wgsl*/ `
    struct ContourData {
      pointStartIndex: u32,
      pointCount: u32,
      height: f32,
      parentIndex: i32,
      depth: u32,
      childStartIndex: u32,
      childCount: u32,
      isCoastline: u32,
      bboxMinX: f32,
      bboxMinY: f32,
      bboxMaxX: f32,
      bboxMaxY: f32,
      skipCount: u32,  // Number of contours in subtree (for DFS skip traversal)
    }
  `,
};

// =============================================================================
// Terrain Height Core Functions
// =============================================================================

/**
 * Fast containment test - only computes winding number, no distance.
 * Returns true if point is inside the contour.
 *
 * Includes early bbox check to skip the winding test entirely for
 * points that are clearly outside.
 *
 * Dependencies: fn_pointLeftOfSegment, struct_ContourData
 */
export const fn_isInsideContour: ShaderModule = {
  code: /*wgsl*/ `
    fn isInsideContour(
      worldPos: vec2<f32>,
      contourIndex: u32,
      vertices: ptr<storage, array<vec2<f32>>, read>,
      contours: ptr<storage, array<ContourData>, read>
    ) -> bool {
      let c = (*contours)[contourIndex];

      // Early bbox check
      if (worldPos.x < c.bboxMinX || worldPos.x > c.bboxMaxX ||
          worldPos.y < c.bboxMinY || worldPos.y > c.bboxMaxY) {
        return false;
      }

      let n = c.pointCount;
      let start = c.pointStartIndex;

      var windingNumber: i32 = 0;

      // Iterate over pre-sampled polygon edges - winding test only
      for (var i: u32 = 0u; i < n; i++) {
        let a = (*vertices)[start + i];
        let b = (*vertices)[start + ((i + 1u) % n)];

        // Winding number calculation (no distance computation)
        if (a.y <= worldPos.y) {
          if (b.y > worldPos.y && pointLeftOfSegment(a, b, worldPos) > 0.0) {
            windingNumber += 1;
          }
        } else {
          if (b.y <= worldPos.y && pointLeftOfSegment(a, b, worldPos) < 0.0) {
            windingNumber -= 1;
          }
        }
      }

      return windingNumber != 0;
    }
  `,
  dependencies: [fn_pointLeftOfSegment, struct_ContourData],
};

/**
 * Compute minimum distance to contour boundary.
 * Only call this when you need the actual distance (e.g., for IDW blending).
 * For containment checks, use isInsideContour instead.
 *
 * Dependencies: fn_pointToLineSegmentDistanceSq, struct_ContourData
 */
export const fn_computeDistanceToBoundary: ShaderModule = {
  code: /*wgsl*/ `
    fn computeDistanceToBoundary(
      worldPos: vec2<f32>,
      contourIndex: u32,
      vertices: ptr<storage, array<vec2<f32>>, read>,
      contours: ptr<storage, array<ContourData>, read>
    ) -> f32 {
      let c = (*contours)[contourIndex];
      let n = c.pointCount;
      let start = c.pointStartIndex;

      // Track squared distance to avoid sqrt in inner loop
      var minDistSq: f32 = 1e20;

      // Iterate over pre-sampled polygon edges - distance only
      for (var i: u32 = 0u; i < n; i++) {
        let a = (*vertices)[start + i];
        let b = (*vertices)[start + ((i + 1u) % n)];

        let distSq = pointToLineSegmentDistanceSq(worldPos, a, b);
        minDistSq = min(minDistSq, distSq);
      }

      return sqrt(minDistSq);
    }
  `,
  dependencies: [fn_pointToLineSegmentDistanceSq, struct_ContourData],
};

/**
 * Compute signed distance to a contour polygon (legacy, combines both operations).
 * Negative distance = inside, positive = outside.
 *
 * Dependencies: fn_isInsideContour, fn_computeDistanceToBoundary
 */
export const fn_computeSignedDistance: ShaderModule = {
  code: /*wgsl*/ `
    fn computeSignedDistance(
      worldPos: vec2<f32>,
      contourIndex: u32,
      vertices: ptr<storage, array<vec2<f32>>, read>,
      contours: ptr<storage, array<ContourData>, read>
    ) -> f32 {
      let inside = isInsideContour(worldPos, contourIndex, vertices, contours);
      let dist = computeDistanceToBoundary(worldPos, contourIndex, vertices, contours);
      return select(dist, -dist, inside);
    }
  `,
  dependencies: [fn_isInsideContour, fn_computeDistanceToBoundary],
};

// =============================================================================
// Terrain Height Compute Functions
// =============================================================================

/**
 * Compute terrain height at a world point using IDW interpolation.
 *
 * Algorithm:
 * 1. Find the deepest contour containing the point using DFS skip traversal
 *    (uses fast winding-only test, no distance calculation)
 * 2. Compute distance to the deepest contour and each of its children
 * 3. Blend heights using inverse distance weighting:
 *    height = sum(h_i / d_i) / sum(1 / d_i)
 *
 * Contours are ordered in DFS pre-order. Each contour has a skipCount
 * indicating how many contours are in its subtree. If we're not inside
 * a contour, we skip its entire subtree.
 *
 * This creates smooth height transitions between contours.
 *
 * Dependencies: fn_isInsideContour, fn_computeDistanceToBoundary
 */
export const fn_computeTerrainHeight: ShaderModule = {
  code: /*wgsl*/ `
    // Minimum distance to avoid division by zero in IDW (private to this module)
    const _IDW_MIN_DIST: f32 = 0.1;

    fn computeTerrainHeight(
      worldPos: vec2<f32>,
      vertices: ptr<storage, array<vec2<f32>>, read>,
      contours: ptr<storage, array<ContourData>, read>,
      contourCount: u32,
      defaultDepth: f32
    ) -> f32 {
      // Phase 1: Find the deepest containing contour using DFS skip traversal
      // Uses fast winding-only test - no distance calculation yet
      var deepestIndex: i32 = -1;
      var deepestDepth: u32 = 0u;

      var i: u32 = 0u;
      // lastToCheck narrows as we find containing contours - if we're inside
      // a contour, we can skip its siblings (only need to check descendants)
      var lastToCheck: u32 = contourCount;

      while (i < lastToCheck) {
        let contour = (*contours)[i];

        // Fast containment test - includes bbox check, winding number only, no distance
        if (isInsideContour(
          worldPos,
          i,
          vertices,
          contours
        )) {
          // Update if this is deeper than current deepest
          if (contour.depth >= deepestDepth) {
            deepestDepth = contour.depth;
            deepestIndex = i32(i);
          }
          // Narrow search to only this contour's descendants
          // (if we're inside this contour, we can't be inside its siblings)
          lastToCheck = i + contour.skipCount + 1u;
          // Continue to children (next contour in DFS order)
          i += 1u;
        } else {
          // Not inside this contour, skip entire subtree
          i += contour.skipCount + 1u;
        }
      }

      // Phase 2: If not inside any contour, return default depth
      if (deepestIndex < 0) {
        return defaultDepth;
      }

      let parent = (*contours)[u32(deepestIndex)];

      // Phase 3: If the parent has no children, return its height directly
      // (no IDW blending needed, so skip distance calculation entirely)
      if (parent.childCount == 0u) {
        return parent.height;
      }

      // Phase 4: IDW interpolation between parent and children
      // NOW we compute distances - only for the parent and its children
      let distToParent = computeDistanceToBoundary(
        worldPos,
        u32(deepestIndex),
        vertices,
        contours
      );
      let parentWeight = 1.0 / max(distToParent, _IDW_MIN_DIST);
      var totalWeight = parentWeight;
      var weightedSum = parent.height * parentWeight;

      for (var c: u32 = 0u; c < parent.childCount; c++) {
        let childIndex = children[parent.childStartIndex + c];
        let child = (*contours)[childIndex];

        // Compute distance to this child's boundary
        // We know we're outside the child (since parent is deepest), so distance is positive
        let distToChild = computeDistanceToBoundary(
          worldPos,
          childIndex,
          vertices,
          contours
        );

        let childWeight = 1.0 / max(distToChild, _IDW_MIN_DIST);
        totalWeight += childWeight;
        weightedSum += child.height * childWeight;
      }

      return weightedSum / totalWeight;
    }
  `,
  dependencies: [fn_isInsideContour, fn_computeDistanceToBoundary],
};

/**
 * Estimate terrain normal using finite differences.
 *
 * Dependencies: fn_computeTerrainHeight
 */
export const fn_computeTerrainNormal: ShaderModule = {
  code: /*wgsl*/ `
    fn computeTerrainNormal(
      worldPos: vec2<f32>,
      vertices: ptr<storage, array<vec2<f32>>, read>,
      contours: ptr<storage, array<ContourData>, read>,
      contourCount: u32,
      defaultDepth: f32
    ) -> vec2<f32> {
      let h = 1.0; // Sample offset
      let hCenter = computeTerrainHeight(worldPos, vertices, contours, contourCount, defaultDepth);
      let hRight = computeTerrainHeight(worldPos + vec2<f32>(h, 0.0), vertices, contours, contourCount, defaultDepth);
      let hUp = computeTerrainHeight(worldPos + vec2<f32>(0.0, h), vertices, contours, contourCount, defaultDepth);

      let dx = hRight - hCenter;
      let dy = hUp - hCenter;

      // Normal from gradient (pointing up from surface)
      let normal3d = normalize(vec3<f32>(-dx, -dy, h));
      return vec2<f32>(normal3d.x, normal3d.y);
    }
  `,
  dependencies: [fn_computeTerrainHeight],
};
