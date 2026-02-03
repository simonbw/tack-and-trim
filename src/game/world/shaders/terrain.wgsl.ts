/**
 * Terrain shader modules for height field computation.
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";

/**
 * Catmull-Rom spline evaluation module.
 * Provides smooth curve interpolation between control points.
 */
export const catmullRomModule: ShaderModule = {
  code: /*wgsl*/ `
    // Evaluate Catmull-Rom spline at parameter t (0-1) between p1 and p2
    // p0, p1, p2, p3 are four consecutive control points
    fn catmullRomPoint(p0: vec2<f32>, p1: vec2<f32>, p2: vec2<f32>, p3: vec2<f32>, t: f32) -> vec2<f32> {
      let t2 = t * t;
      let t3 = t2 * t;
      return 0.5 * (
        2.0 * p1 +
        (-p0 + p2) * t +
        (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2 +
        (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3
      );
    }
  `,
};

/**
 * Distance calculation utilities module.
 * Provides point-to-segment distance and winding number testing.
 */
export const distanceModule: ShaderModule = {
  code: /*wgsl*/ `
    // Compute minimum distance from point p to line segment [a, b]
    fn pointToLineSegmentDistance(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> f32 {
      let ab = b - a;
      let lengthSq = dot(ab, ab);
      if (lengthSq == 0.0) {
        return length(p - a);
      }
      let t = clamp(dot(p - a, ab) / lengthSq, 0.0, 1.0);
      let nearest = a + t * ab;
      return length(p - nearest);
    }

    // Test if point p is left of line segment [a, b] (for winding number algorithm)
    // Returns positive if left, negative if right, zero if collinear
    fn pointLeftOfSegment(a: vec2<f32>, b: vec2<f32>, p: vec2<f32>) -> f32 {
      return (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
    }
  `,
};

/**
 * IDW (Inverse Distance Weighting) interpolation module.
 * Provides blending based on distance to features.
 */
export const idwModule: ShaderModule = {
  code: /*wgsl*/ `
    // Compute IDW weight from distance
    // Uses 1/distance weighting with minimum distance clamp
    fn computeIDWWeight(distance: f32, minDist: f32) -> f32 {
      return 1.0 / max(distance, minDist);
    }

    // Blend values using IDW
    // weights: array of weights
    // values: array of values to blend
    // Returns weighted average
    fn blendIDW(value1: f32, weight1: f32, value2: f32, weight2: f32) -> f32 {
      let totalWeight = weight1 + weight2;
      return (value1 * weight1 + value2 * weight2) / totalWeight;
    }
  `,
};

/**
 * Terrain height calculation module (without bindings).
 * Provides the core signed distance and height computation logic.
 *
 * This module is used for CPU-side terrain height queries.
 * For GPU shaders, use terrainHeightGPUModule which includes bindings.
 */
export const terrainHeightCoreModule: ShaderModule = {
  code: /*wgsl*/ `
    // Compute signed distance to a contour
    // Negative distance = inside, positive = outside
    // Uses winding number algorithm for inside/outside testing
    fn computeSignedDistance(
      worldPos: vec2<f32>,
      contourIndex: u32,
      controlPoints: ptr<storage, array<vec2<f32>>, read>,
      contours: ptr<storage, array<ContourData>, read>,
      splineSubdivisions: u32
    ) -> f32 {
      let c = (*contours)[contourIndex];
      let n = c.pointCount;
      let start = c.pointStartIndex;

      var minDist: f32 = 1e10;
      var windingNumber: i32 = 0;

      for (var i: u32 = 0u; i < n; i++) {
        let i0 = (i + n - 1u) % n;
        let i1 = i;
        let i2 = (i + 1u) % n;
        let i3 = (i + 2u) % n;

        let p0 = (*controlPoints)[start + i0];
        let p1 = (*controlPoints)[start + i1];
        let p2 = (*controlPoints)[start + i2];
        let p3 = (*controlPoints)[start + i3];

        for (var j: u32 = 0u; j < splineSubdivisions; j++) {
          let t0 = f32(j) / f32(splineSubdivisions);
          let t1 = f32(j + 1u) / f32(splineSubdivisions);

          let a = catmullRomPoint(p0, p1, p2, p3, t0);
          let b = catmullRomPoint(p0, p1, p2, p3, t1);

          let dist = pointToLineSegmentDistance(worldPos, a, b);
          minDist = min(minDist, dist);

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
      }

      let inside = windingNumber != 0;
      return select(minDist, -minDist, inside);
    }
  `,
  dependencies: [catmullRomModule, distanceModule],
};

/**
 * Terrain data structures module.
 * Defines structures used in terrain computation.
 */
export const terrainStructuresModule: ShaderModule = {
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
      _padding: u32,
    }
  `,
};
