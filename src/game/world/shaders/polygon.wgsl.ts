/**
 * Polygon utility shader modules for point-in-polygon testing.
 *
 * These functions are used by both terrain and shadow-attenuation shaders
 * for determining containment within arbitrary polygons.
 *
 * Naming convention:
 * - `fn_` prefix for function modules
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";

/**
 * Test if point p is left of line segment [a, b] (for winding number algorithm).
 * Returns positive if left, negative if right, zero if collinear.
 *
 * This is the cross product of (b - a) and (p - a), which gives the signed
 * area of the parallelogram formed by the vectors. The sign indicates which
 * side of the line the point is on.
 */
export const fn_pointLeftOfSegment: ShaderModule = {
  code: /*wgsl*/ `
fn pointLeftOfSegment(a: vec2<f32>, b: vec2<f32>, p: vec2<f32>) -> f32 {
  return (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
}
`,
};

/**
 * Test if a point is inside a polygon using the winding number algorithm.
 *
 * The polygon is defined by a contiguous slice of vertices in a storage buffer.
 * Vertices are assumed to form a closed polygon (last vertex connects to first).
 *
 * @param worldPos - The point to test
 * @param vertices - Storage buffer containing all polygon vertices
 * @param startIndex - Index of the first vertex in this polygon
 * @param vertexCount - Number of vertices in this polygon
 * @returns true if the point is inside the polygon
 *
 * Dependencies: fn_pointLeftOfSegment
 */
export const fn_isInsidePolygon: ShaderModule = {
  dependencies: [fn_pointLeftOfSegment],
  code: /*wgsl*/ `
fn isInsidePolygon(
  worldPos: vec2<f32>,
  vertices: ptr<storage, array<vec2<f32>>, read>,
  startIndex: u32,
  vertexCount: u32,
) -> bool {
  var windingNumber: i32 = 0;

  // Iterate over polygon edges
  for (var i: u32 = 0u; i < vertexCount; i++) {
    let a = (*vertices)[startIndex + i];
    let b = (*vertices)[startIndex + ((i + 1u) % vertexCount)];

    // Winding number calculation
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
};

/**
 * Test if a point is inside a polygon with bounding box early-exit.
 *
 * Same as fn_isInsidePolygon but first checks a bounding box to skip
 * the winding number test for points that are clearly outside.
 *
 * @param worldPos - The point to test
 * @param vertices - Storage buffer containing all polygon vertices
 * @param startIndex - Index of the first vertex in this polygon
 * @param vertexCount - Number of vertices in this polygon
 * @param bboxMin - Minimum corner of bounding box
 * @param bboxMax - Maximum corner of bounding box
 * @returns true if the point is inside the polygon
 *
 * Dependencies: fn_pointLeftOfSegment
 */
export const fn_isInsidePolygonWithBBox: ShaderModule = {
  dependencies: [fn_pointLeftOfSegment],
  code: /*wgsl*/ `
fn isInsidePolygonWithBBox(
  worldPos: vec2<f32>,
  vertices: ptr<storage, array<vec2<f32>>, read>,
  startIndex: u32,
  vertexCount: u32,
  bboxMin: vec2<f32>,
  bboxMax: vec2<f32>,
) -> bool {
  // Early bbox check
  if (worldPos.x < bboxMin.x || worldPos.x > bboxMax.x ||
      worldPos.y < bboxMin.y || worldPos.y > bboxMax.y) {
    return false;
  }

  var windingNumber: i32 = 0;

  // Iterate over polygon edges
  for (var i: u32 = 0u; i < vertexCount; i++) {
    let a = (*vertices)[startIndex + i];
    let b = (*vertices)[startIndex + ((i + 1u) % vertexCount)];

    // Winding number calculation
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
};

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
 * Compute minimum distance from a point to a polygon boundary.
 *
 * @param worldPos - The point to test
 * @param vertices - Storage buffer containing all polygon vertices
 * @param startIndex - Index of the first vertex in this polygon
 * @param vertexCount - Number of vertices in this polygon
 * @returns Distance to the nearest edge of the polygon
 *
 * Dependencies: fn_pointToLineSegmentDistanceSq
 */
export const fn_distanceToPolygonBoundary: ShaderModule = {
  dependencies: [fn_pointToLineSegmentDistanceSq],
  code: /*wgsl*/ `
fn distanceToPolygonBoundary(
  worldPos: vec2<f32>,
  vertices: ptr<storage, array<vec2<f32>>, read>,
  startIndex: u32,
  vertexCount: u32,
) -> f32 {
  var minDistSq: f32 = 1e20;

  for (var i: u32 = 0u; i < vertexCount; i++) {
    let a = (*vertices)[startIndex + i];
    let b = (*vertices)[startIndex + ((i + 1u) % vertexCount)];

    let distSq = pointToLineSegmentDistanceSq(worldPos, a, b);
    minDistSq = min(minDistSq, distSq);
  }

  return sqrt(minDistSq);
}
`,
};
