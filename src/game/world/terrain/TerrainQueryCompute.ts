/**
 * TerrainQueryCompute: GPU compute shader for batch terrain queries.
 *
 * Queries terrain properties for multiple points in parallel:
 * - Height/depth value
 * - Normal vector (stubbed as (0, 1) in Phase 2)
 * - Terrain type (stubbed as 0 in Phase 2)
 */

import { ComputeShader } from "../../../core/graphics/webgpu/ComputeShader";
import type { BindingsDefinition } from "../../../core/graphics/webgpu/ShaderBindings";
import { TERRAIN_WGSL_UTILS } from "./TerrainTileCompute";

/**
 * Bindings for terrain query compute shader.
 */
export const TerrainQueryBindings = {
  /** Query point positions (vec2f array) */
  queryPoints: { type: "storage" },
  /** Query results (f32 array: height, normal.xy, terrainType for each point) */
  results: { type: "storageRW" },
  /** Contour metadata array (ContourGPU structs) */
  contours: { type: "storage" },
  /** Control point positions for all contours (vec2f array) */
  controlPoints: { type: "storage" },
  /** Global parameters (default depth, root count) */
  params: { type: "uniform" },
} as const satisfies BindingsDefinition;

/**
 * GPU compute shader for batch terrain queries.
 */
export class TerrainQueryCompute extends ComputeShader<
  typeof TerrainQueryBindings
> {
  readonly bindings = TerrainQueryBindings;
  readonly workgroupSize = [64, 1] as const;

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

@group(0) @binding(0) var<storage, read> queryPoints: array<vec2f>;
@group(0) @binding(1) var<storage, read_write> results: array<f32>;
@group(0) @binding(2) var<storage, read> contours: array<ContourGPU>;
@group(0) @binding(3) var<storage, read> controlPoints: array<vec2f>;
@group(0) @binding(4) var<uniform> params: Params;

// ============================================================================
// Main Compute Shader
// ============================================================================

@compute @workgroup_size(64, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  // Bounds check
  if (id.x >= arrayLength(&queryPoints)) {
    return;
  }

  let point = queryPoints[id.x];

  // Compute height using shared utility function
  let height = computeHeightAt(point, params.rootCount, params.defaultDepth);

  // Phase 2: Stub normal and terrain type
  // TODO Phase 3+: Compute gradient for normals, classify terrain type
  let normal = vec2f(0.0, 1.0);
  let terrainType = 0.0;

  // Pack into result buffer (stride=4: height, normal.x, normal.y, terrainType)
  let offset = id.x * 4u;
  results[offset + 0u] = height;
  results[offset + 1u] = normal.x;
  results[offset + 2u] = normal.y;
  results[offset + 3u] = terrainType;
}
`;
}
