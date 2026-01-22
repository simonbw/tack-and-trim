/**
 * Terrain state compute shader.
 *
 * Extends ComputeShader base class to compute terrain height using:
 * - Catmull-Rom splines for contour definition
 * - Floor/ceiling algorithm for height interpolation
 * - Signed distance field for inside/outside determination
 * - Simplex noise for rolling hills
 *
 * Output format (rgba32float):
 * - R: Signed height in world units (negative = underwater depth, positive = terrain height)
 * - GBA: Reserved
 */

import { ComputeShader } from "../../../../core/graphics/webgpu/ComputeShader";
import { SIMPLEX_NOISE_3D_WGSL } from "../../../../core/graphics/webgpu/WGSLSnippets";
import { TERRAIN_CONSTANTS_WGSL } from "../TerrainConstants";

const bindings = {
  params: { type: "uniform" },
  controlPoints: { type: "storage" },
  contours: { type: "storage" },
  outputTexture: { type: "storageTexture", format: "rgba32float" },
} as const;

/**
 * Terrain state compute shader using the ComputeShader base class.
 */
export class TerrainStateShader extends ComputeShader<typeof bindings> {
  readonly bindings = bindings;
  readonly workgroupSize = [8, 8] as const;

  readonly code = /*wgsl*/ `
${TERRAIN_CONSTANTS_WGSL}

struct Params {
  time: f32,
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  textureSizeX: f32,
  textureSizeY: f32,
  contourCount: u32,
  defaultDepth: f32,
  _padding1: f32,
  _padding2: f32,
  _padding3: f32,
}

struct ContourData {
  pointStartIndex: u32,
  pointCount: u32,
  height: f32,
  hillFrequency: f32,
  hillAmplitude: f32,
  _padding: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> controlPoints: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read> contours: array<ContourData>;
@group(0) @binding(3) var outputTexture: texture_storage_2d<rgba32float, write>;

// Include simplex 3D noise (use with z=0 for 2D noise)
${SIMPLEX_NOISE_3D_WGSL}

// Use simplex3D with z=0 for 2D noise
fn simplex2D(p: vec2<f32>) -> f32 {
  return simplex3D(vec3<f32>(p.x, p.y, 0.0));
}

// ============================================================================
// Catmull-Rom spline evaluation
// ============================================================================

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

// ============================================================================
// Distance functions
// ============================================================================

fn pointToSegmentDistance(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> f32 {
  let ab = b - a;
  let lengthSq = dot(ab, ab);
  if (lengthSq == 0.0) {
    return length(p - a);
  }
  let t = clamp(dot(p - a, ab) / lengthSq, 0.0, 1.0);
  let nearest = a + t * ab;
  return length(p - nearest);
}

// Returns positive if p is to the left of line a->b
fn isLeft(a: vec2<f32>, b: vec2<f32>, p: vec2<f32>) -> f32 {
  return (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
}

// ============================================================================
// Signed distance computation for a contour
// ============================================================================

fn computeSignedDistance(worldPos: vec2<f32>, contourIndex: u32) -> f32 {
  let c = contours[contourIndex];
  let n = c.pointCount;
  let start = c.pointStartIndex;

  var minDist: f32 = 1e10;
  var windingNumber: i32 = 0;

  // For each control point pair, subdivide Catmull-Rom and check distance
  for (var i: u32 = 0u; i < n; i++) {
    // Get indices for Catmull-Rom (wrapping for closed loop)
    let i0 = (i + n - 1u) % n;
    let i1 = i;
    let i2 = (i + 1u) % n;
    let i3 = (i + 2u) % n;

    let p0 = controlPoints[start + i0];
    let p1 = controlPoints[start + i1];
    let p2 = controlPoints[start + i2];
    let p3 = controlPoints[start + i3];

    // Subdivide this curve segment
    for (var j: u32 = 0u; j < SPLINE_SUBDIVISIONS; j++) {
      let t0 = f32(j) / f32(SPLINE_SUBDIVISIONS);
      let t1 = f32(j + 1u) / f32(SPLINE_SUBDIVISIONS);

      let a = catmullRomPoint(p0, p1, p2, p3, t0);
      let b = catmullRomPoint(p0, p1, p2, p3, t1);

      // Distance to segment
      let dist = pointToSegmentDistance(worldPos, a, b);
      minDist = min(minDist, dist);

      // Winding number contribution (crossing number algorithm)
      if (a.y <= worldPos.y) {
        if (b.y > worldPos.y && isLeft(a, b, worldPos) > 0.0) {
          windingNumber += 1;
        }
      } else {
        if (b.y <= worldPos.y && isLeft(a, b, worldPos) < 0.0) {
          windingNumber -= 1;
        }
      }
    }
  }

  // Inside if winding number is non-zero
  let inside = windingNumber != 0;
  return select(minDist, -minDist, inside);
}

// ============================================================================
// Floor/ceiling height computation
// ============================================================================

// Returns: x = floor index (-1 if none), y = floor signed distance
//          z = ceiling index (-1 if none), w = ceiling distance
fn findFloorCeiling(worldPos: vec2<f32>) -> vec4<f32> {
  var floorIndex: i32 = -1;
  var floorDist: f32 = 0.0;
  var ceilingIndex: i32 = -1;
  var ceilingDist: f32 = 1e10;

  // Contours are pre-sorted by height (ascending) in the buffer
  for (var i: u32 = 0u; i < params.contourCount; i++) {
    let signedDist = computeSignedDistance(worldPos, i);

    if (signedDist < 0.0) {
      // Point is inside this contour - it becomes the new floor
      floorIndex = i32(i);
      floorDist = signedDist;
    } else {
      // Point is outside this contour - potential ceiling
      let floorHeight = select(-1e10, contours[u32(floorIndex)].height, floorIndex >= 0);
      if (contours[i].height > floorHeight) {
        // Track the nearest ceiling contour
        if (signedDist < ceilingDist) {
          ceilingIndex = i32(i);
          ceilingDist = signedDist;
        }
      }
    }
  }

  return vec4<f32>(f32(floorIndex), floorDist, f32(ceilingIndex), ceilingDist);
}

fn computeHeight(worldPos: vec2<f32>, fc: vec4<f32>) -> f32 {
  let floorIndex = i32(fc.x);
  let floorDist = fc.y;
  let ceilingIndex = i32(fc.z);
  let ceilingDist = fc.w;

  // No floor - point is in deep ocean
  if (floorIndex < 0) {
    // If there's a ceiling, transition from default depth toward it
    if (ceilingIndex >= 0) {
      let ceiling = contours[u32(ceilingIndex)];
      let transitionDist: f32 = 30.0; // Feet to transition from deep to shallow
      let t = min(1.0, ceilingDist / transitionDist);
      // Smoothstep for gradual transition
      let smoothT = t * t * (3.0 - 2.0 * t);
      return params.defaultDepth + (ceiling.height - params.defaultDepth) * (1.0 - smoothT);
    }
    return params.defaultDepth;
  }

  let floor = contours[u32(floorIndex)];

  // Have a floor but no ceiling - point is at or above floor height
  if (ceilingIndex < 0) {
    // Apply hill noise based on floor contour settings
    let noise = simplex2D(worldPos * floor.hillFrequency);
    let hillVariation = noise * floor.hillAmplitude;
    return floor.height + hillVariation;
  }

  let ceiling = contours[u32(ceilingIndex)];

  // Have both floor and ceiling - interpolate between them
  let distInland = -floorDist; // Convert to positive distance inside floor
  let totalDist = distInland + ceilingDist;

  if (totalDist <= 0.0) {
    return floor.height;
  }

  // Linear interpolation factor (0 at floor boundary, 1 at ceiling boundary)
  let t = distInland / totalDist;

  // Interpolate height
  let baseHeight = floor.height + t * (ceiling.height - floor.height);

  // Apply hill noise using the ceiling's settings (scaled by transition progress)
  let noise = simplex2D(worldPos * ceiling.hillFrequency);
  let hillVariation = noise * ceiling.hillAmplitude * t;

  return baseHeight + hillVariation;
}

// ============================================================================
// Main compute entry point
// ============================================================================

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let texSize = vec2<f32>(params.textureSizeX, params.textureSizeY);

  // Check bounds
  if (f32(globalId.x) >= texSize.x || f32(globalId.y) >= texSize.y) {
    return;
  }

  // Convert pixel coords to UV (0-1)
  let uv = (vec2<f32>(globalId.xy) + 0.5) / texSize;

  // Map UV to world position
  let worldPos = vec2<f32>(
    params.viewportLeft + uv.x * params.viewportWidth,
    params.viewportTop + uv.y * params.viewportHeight
  );

  // Find floor and ceiling contours
  let fc = findFloorCeiling(worldPos);

  // Compute height from floor/ceiling
  let terrainHeight = computeHeight(worldPos, fc);

  // Store signed height directly (negative = underwater, positive = above water)
  textureStore(outputTexture, vec2<i32>(globalId.xy), vec4<f32>(terrainHeight, 0.0, 0.0, 1.0));
}
`;
}
