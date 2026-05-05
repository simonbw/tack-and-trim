/**
 * Point-in-contour and signed-distance-to-boundary helpers.
 *
 * These primitives operate on a single contour at a time and are the
 * building blocks for the higher-level terrain height/gradient functions
 * in `terrain.wgsl`.
 *
 * Naming convention:
 * - `fn_` prefix for function modules
 * - `struct_` prefix for struct modules
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";
import {
  fn_pointLeftOfSegment,
  fn_pointToLineSegmentDistanceSq,
} from "./polygon.wgsl";
import {
  struct_ContourData,
  fn_getTerrainVertex,
  fn_getContourData,
  fn_getContainmentCellFlag,
} from "./terrain-packed.wgsl";

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
      packedTerrain: ptr<storage, array<u32>, read>
    ) -> bool {
      let c = getContourData(packedTerrain, contourIndex);

      // Early bbox check
      let bboxW = c.bboxMaxX - c.bboxMinX;
      let bboxH = c.bboxMaxY - c.bboxMinY;
      if (worldPos.x < c.bboxMinX || worldPos.x > c.bboxMaxX ||
          worldPos.y < c.bboxMinY || worldPos.y > c.bboxMaxY ||
          bboxW <= 0.0 || bboxH <= 0.0) {
        return false;
      }

      // Containment grid fast path — O(1) for ~95% of queries
      let col = u32(clamp(floor((worldPos.x - c.bboxMinX) * (64.0 / bboxW)), 0.0, 63.0));
      let row = u32(clamp(floor((worldPos.y - c.bboxMinY) * (64.0 / bboxH)), 0.0, 63.0));
      let flag = getContainmentCellFlag(packedTerrain, contourIndex, row * 64u + col);
      if (flag == 0u) { return false; }   // OUTSIDE
      if (flag == 1u) { return true; }    // INSIDE
      // BOUNDARY (flag == 2): fall through to winding test

      let n = c.pointCount;
      let start = c.pointStartIndex;

      var windingNumber: i32 = 0;

      // Iterate over pre-sampled polygon edges - winding test only
      for (var i: u32 = 0u; i < n; i++) {
        let a = getTerrainVertex(packedTerrain, start + i);
        let b = getTerrainVertex(packedTerrain, start + ((i + 1u) % n));

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
  dependencies: [
    fn_pointLeftOfSegment,
    struct_ContourData,
    fn_getContourData,
    fn_getTerrainVertex,
    fn_getContainmentCellFlag,
  ],
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
      packedTerrain: ptr<storage, array<u32>, read>
    ) -> f32 {
      let c = getContourData(packedTerrain, contourIndex);
      let n = c.pointCount;
      let start = c.pointStartIndex;

      // Track squared distance to avoid sqrt in inner loop
      var minDistSq: f32 = 1e20;

      // Iterate over pre-sampled polygon edges - distance only
      for (var i: u32 = 0u; i < n; i++) {
        let a = getTerrainVertex(packedTerrain, start + i);
        let b = getTerrainVertex(packedTerrain, start + ((i + 1u) % n));

        let distSq = pointToLineSegmentDistanceSq(worldPos, a, b);
        minDistSq = min(minDistSq, distSq);
      }

      return sqrt(minDistSq);
    }
  `,
  dependencies: [
    fn_pointToLineSegmentDistanceSq,
    struct_ContourData,
    fn_getContourData,
    fn_getTerrainVertex,
  ],
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
      packedTerrain: ptr<storage, array<u32>, read>
    ) -> f32 {
      let inside = isInsideContour(worldPos, contourIndex, packedTerrain);
      let dist = computeDistanceToBoundary(worldPos, contourIndex, packedTerrain);
      return select(dist, -dist, inside);
    }
  `,
  dependencies: [fn_isInsideContour, fn_computeDistanceToBoundary],
};

/**
 * Result of distance-to-boundary computation with gradient.
 * The gradient is the unit direction from the nearest boundary point to the query point.
 */
export const struct_BoundaryDistanceGradient: ShaderModule = {
  code: /*wgsl*/ `
    struct BoundaryDistanceGradient {
      distance: f32,
      gradientX: f32,
      gradientY: f32,
    }
  `,
};

/**
 * Compute minimum distance to contour boundary AND the gradient direction.
 * The gradient is the unit vector from the nearest boundary point to the query point,
 * which is the spatial derivative of the distance field.
 *
 * Dependencies: struct_ContourData, struct_BoundaryDistanceGradient
 */
export const fn_computeDistanceToBoundaryWithGradient: ShaderModule = {
  code: /*wgsl*/ `
    fn computeDistanceToBoundaryWithGradient(
      worldPos: vec2<f32>,
      contourIndex: u32,
      packedTerrain: ptr<storage, array<u32>, read>
    ) -> BoundaryDistanceGradient {
      let c = getContourData(packedTerrain, contourIndex);
      let n = c.pointCount;
      let start = c.pointStartIndex;

      var minDistSq: f32 = 1e20;
      var bestDx: f32 = 0.0;
      var bestDy: f32 = 0.0;

      for (var i: u32 = 0u; i < n; i++) {
        let a = getTerrainVertex(packedTerrain, start + i);
        let b = getTerrainVertex(packedTerrain, start + ((i + 1u) % n));

        let ab = b - a;
        let lengthSq = dot(ab, ab);

        var dx: f32;
        var dy: f32;
        var distSq: f32;
        if (lengthSq == 0.0) {
          dx = worldPos.x - a.x;
          dy = worldPos.y - a.y;
          distSq = dx * dx + dy * dy;
        } else {
          let t = clamp(dot(worldPos - a, ab) / lengthSq, 0.0, 1.0);
          let nearest = a + t * ab;
          dx = worldPos.x - nearest.x;
          dy = worldPos.y - nearest.y;
          distSq = dx * dx + dy * dy;
        }

        if (distSq < minDistSq) {
          minDistSq = distSq;
          bestDx = dx;
          bestDy = dy;
        }
      }

      var result: BoundaryDistanceGradient;
      let distance = sqrt(minDistSq);
      result.distance = distance;
      if (distance > 1e-9) {
        let invDist = 1.0 / distance;
        result.gradientX = bestDx * invDist;
        result.gradientY = bestDy * invDist;
      } else {
        result.gradientX = 0.0;
        result.gradientY = 0.0;
      }
      return result;
    }
  `,
  dependencies: [
    struct_BoundaryDistanceGradient,
    struct_ContourData,
    fn_getContourData,
    fn_getTerrainVertex,
  ],
};
