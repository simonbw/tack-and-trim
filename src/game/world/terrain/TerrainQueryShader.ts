/**
 * Terrain Query Compute Shader
 *
 * Samples terrain data (height, normal, terrain type) at arbitrary query points.
 * Uses terrain shader modules for signed distance computation.
 *
 * Input:  pointBuffer (storage) - array of vec2<f32> query points
 * Output: resultBuffer (storage) - array of TerrainQueryResult structs
 */

import { ComputeShader } from "../../../core/graphics/webgpu/ComputeShader";
import {
  terrainStructuresModule,
  terrainHeightCoreModule,
} from "../shaders/terrain.wgsl";
import { SPLINE_SUBDIVISIONS } from "../../world-data/terrain/TerrainConstants";

const bindings = {
  params: { type: "uniform", wgslType: "Params" },
  pointBuffer: { type: "storage", wgslType: "array<vec2<f32>>" },
  resultBuffer: { type: "storageRW", wgslType: "array<TerrainQueryResult>" },
  controlPoints: { type: "storage", wgslType: "array<vec2<f32>>" },
  contours: { type: "storage", wgslType: "array<ContourData>" },
  children: { type: "storage", wgslType: "array<u32>" },
} as const;

/**
 * Terrain query compute shader.
 * Computes terrain height at provided query points using tree-based algorithm.
 */
export class TerrainQueryShader extends ComputeShader<typeof bindings> {
  readonly bindings = bindings;
  readonly workgroupSize = [64, 1, 1] as const;

  protected modules = [terrainStructuresModule, terrainHeightCoreModule];

  protected mainCode = /*wgsl*/ `
// Query parameters
struct Params {
  pointCount: u32,
  contourCount: u32,
  defaultDepth: f32,
  _padding: f32,
}

// Result structure (matches TerrainQueryResult interface)
// stride = 4 floats
struct TerrainQueryResult {
  height: f32,
  normalX: f32,
  normalY: f32,
  terrainType: f32,
}

${this.buildWGSLBindings()}

const SPLINE_SUBDIVISIONS: u32 = ${SPLINE_SUBDIVISIONS}u;
const MIN_DISTANCE: f32 = 0.1; // Min distance for IDW weighting

// Compute terrain height at a world point
// Uses tree-based algorithm: find deepest containing contour
fn computeTerrainHeight(worldPos: vec2<f32>) -> f32 {
  var deepestHeight = params.defaultDepth;
  var deepestDepth: u32 = 0u;

  // Find the deepest contour containing the point
  for (var i: u32 = 0u; i < params.contourCount; i++) {
    let signedDist = computeSignedDistance(
      worldPos,
      i,
      &controlPoints,
      &contours,
      SPLINE_SUBDIVISIONS
    );

    // Inside this contour (negative signed distance)
    if (signedDist < 0.0) {
      let contour = contours[i];
      // Update if this is deeper than current deepest
      if (contour.depth >= deepestDepth) {
        deepestDepth = contour.depth;
        deepestHeight = contour.height;
      }
    }
  }

  return deepestHeight;
}

// Estimate terrain normal using finite differences
fn computeTerrainNormal(worldPos: vec2<f32>) -> vec2<f32> {
  let h = 1.0; // Sample offset
  let hCenter = computeTerrainHeight(worldPos);
  let hRight = computeTerrainHeight(worldPos + vec2<f32>(h, 0.0));
  let hUp = computeTerrainHeight(worldPos + vec2<f32>(0.0, h));

  let dx = hRight - hCenter;
  let dy = hUp - hCenter;

  // Normal from gradient (pointing up from surface)
  let normal3d = normalize(vec3<f32>(-dx, -dy, h));
  return vec2<f32>(normal3d.x, normal3d.y);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let index = globalId.x;

  if (index >= params.pointCount) {
    return;
  }

  let queryPoint = pointBuffer[index];

  var result: TerrainQueryResult;
  result.height = computeTerrainHeight(queryPoint);

  // Compute normal
  let normal = computeTerrainNormal(queryPoint);
  result.normalX = normal.x;
  result.normalY = normal.y;

  // Terrain type: 0 = water (negative height), 1+ = land
  result.terrainType = select(0.0, 1.0, result.height >= 0.0);

  resultBuffer[index] = result;
}
`;
}
