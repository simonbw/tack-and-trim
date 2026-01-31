/**
 * ShadowTileCompute: GPU compute shader for rasterizing shadow polygons into tiles.
 *
 * Takes shadow polygon geometry and renders it into VirtualTexture tiles.
 * Output format: rg32float
 * - R channel: Shadow intensity (0=light, 1=shadowed)
 * - G channel: Distance to edge / 100 (for soft shadows)
 */

import { TileCompute } from "../../../core/graphics/webgpu/virtual-texture/TileCompute";
import type { BindingsDefinition } from "../../../core/graphics/webgpu/ShaderBindings";

/**
 * Bindings for shadow tile compute shader
 */
export const ShadowTileBindings = {
  /** Shadow polygon metadata (vertexStart, vertexCount) */
  polygonMetadata: { type: "storage" },
  /** Vertex positions (vec2f array) */
  vertices: { type: "storage" },
  /** Shared parameters (polygon count) */
  params: { type: "uniform" },
  /** Tile-specific parameters (LOD, position, size) */
  tileParams: { type: "uniform" },
  /** Output shadow texture (rg32float) */
  output: { type: "storageTexture", format: "rg32float" },
} as const satisfies BindingsDefinition;

/**
 * WGSL shader code for shadow tile computation
 */
const SHADOW_TILE_WGSL = /* wgsl */ `
// ============================================================================
// Bindings
// ============================================================================

struct ShadowPolygon {
  vertexStart: u32,
  vertexCount: u32,
  padding0: u32,
  padding1: u32,
}

@group(0) @binding(0) var<storage, read> polygonMetadata: array<ShadowPolygon>;
@group(0) @binding(1) var<storage, read> vertices: array<vec2f>;
@group(0) @binding(2) var<uniform> params: vec4u; // polygonCount, padding...
@group(0) @binding(3) var<uniform> tileParams: vec4f; // lod, tileX, tileY, worldTileSize
@group(0) @binding(4) var output: texture_storage_2d<rg32float, write>;

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Ray casting point-in-polygon test.
 *
 * @param point Test point
 * @param polygon Shadow polygon metadata
 * @return True if point is inside polygon
 */
fn pointInPolygon(point: vec2f, polygon: ShadowPolygon) -> bool {
  let vertexStart = polygon.vertexStart;
  let vertexCount = polygon.vertexCount;

  if (vertexCount < 3u) {
    return false;
  }

  var inside = false;
  var j = vertexCount - 1u;

  for (var i = 0u; i < vertexCount; i++) {
    let vi = vertices[vertexStart + i];
    let vj = vertices[vertexStart + j];

    if ((vi.y > point.y) != (vj.y > point.y)) {
      let intersectX = vj.x + (point.y - vj.y) * (vi.x - vj.x) / (vi.y - vj.y);
      if (point.x < intersectX) {
        inside = !inside;
      }
    }

    j = i;
  }

  return inside;
}

/**
 * Compute distance from point to nearest polygon edge.
 *
 * @param point Test point
 * @param polygon Shadow polygon metadata
 * @return Distance to nearest edge (in world units)
 */
fn distanceToEdge(point: vec2f, polygon: ShadowPolygon) -> f32 {
  let vertexStart = polygon.vertexStart;
  let vertexCount = polygon.vertexCount;

  if (vertexCount < 2u) {
    return 1000.0; // Large distance if invalid polygon
  }

  var minDist = 1000000.0;

  for (var i = 0u; i < vertexCount; i++) {
    let v1 = vertices[vertexStart + i];
    let v2 = vertices[vertexStart + ((i + 1u) % vertexCount)];

    // Compute distance from point to line segment
    let edge = v2 - v1;
    let toPoint = point - v1;
    let edgeLengthSq = dot(edge, edge);

    if (edgeLengthSq < 0.0001) {
      // Degenerate edge - compute distance to point
      minDist = min(minDist, length(toPoint));
      continue;
    }

    // Project point onto line segment
    let t = clamp(dot(toPoint, edge) / edgeLengthSq, 0.0, 1.0);
    let projection = v1 + edge * t;
    let dist = length(point - projection);

    minDist = min(minDist, dist);
  }

  return minDist;
}

// ============================================================================
// Main Compute Kernel
// ============================================================================

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  // Get tile dimensions
  let tileDims = textureDimensions(output);
  let pixelCoord = globalId.xy;

  // Bounds check
  if (pixelCoord.x >= tileDims.x || pixelCoord.y >= tileDims.y) {
    return;
  }

  // Convert pixel to world position
  let lod = tileParams.x;
  let tileX = tileParams.y;
  let tileY = tileParams.z;
  let worldTileSize = tileParams.w;

  let tileOriginWorld = vec2f(tileX, tileY) * worldTileSize;
  let pixelSize = worldTileSize / f32(tileDims.x);
  let worldPos = tileOriginWorld + vec2f(pixelCoord) * pixelSize + vec2f(pixelSize * 0.5);

  // Check containment in any shadow polygon
  let polygonCount = params.x;
  var shadowIntensity = 0.0;
  var minEdgeDist = 1000.0;

  for (var i = 0u; i < polygonCount; i++) {
    let polygon = polygonMetadata[i];

    if (pointInPolygon(worldPos, polygon)) {
      shadowIntensity = 1.0;
      let edgeDist = distanceToEdge(worldPos, polygon);
      minEdgeDist = min(minEdgeDist, edgeDist);
    }
  }

  // Pack output: R=intensity, G=distance/100 (normalized)
  let normalizedDist = clamp(minEdgeDist / 100.0, 0.0, 1.0);
  textureStore(output, pixelCoord, vec4f(shadowIntensity, normalizedDist, 0.0, 1.0));
}
`;

/**
 * Shadow tile compute shader implementation
 */
export class ShadowTileCompute extends TileCompute<typeof ShadowTileBindings> {
  readonly code = SHADOW_TILE_WGSL;
  readonly bindings = ShadowTileBindings;
  readonly workgroupSize = [8, 8] as const;
}
