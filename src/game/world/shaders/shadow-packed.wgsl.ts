/**
 * Packed shadow accessor functions for reading from a single array<u32> buffer.
 *
 * The packed shadow buffer layout:
 * [0] waveDir.x (f32)
 * [1] waveDir.y (f32)
 * [2] polygonCount (u32)
 * [3] verticesOffset (u32) - element index where vertex data starts
 * [4..7] unused/padding
 * [8..] polygons array (12 floats each = PolygonShadowData)
 * [verticesOffset..] vertices (2 floats each, x/y pairs)
 *
 * All float values are stored as u32 and recovered via bitcast<f32>().
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";
import { fn_pointLeftOfSegment } from "./polygon.wgsl";

/**
 * PolygonShadowData struct definition.
 * Defined here (not in shadow-attenuation.wgsl) to avoid circular imports.
 */
export const struct_PolygonShadowData: ShaderModule = {
  preamble: /*wgsl*/ `
// Per-polygon shadow data for Fresnel diffraction calculation
struct PolygonShadowData {
  leftSilhouette: vec2<f32>,
  rightSilhouette: vec2<f32>,
  obstacleWidth: f32,
  vertexStartIndex: u32,
  vertexCount: u32,
  _padding1: f32,
  bboxMin: vec2<f32>,
  bboxMax: vec2<f32>,
}
`,
  code: "",
};

/**
 * Get the wave direction from the packed shadow buffer.
 */
export const fn_getShadowWaveDirection: ShaderModule = {
  code: /*wgsl*/ `
fn getShadowWaveDirection(packed: ptr<storage, array<u32>, read>) -> vec2<f32> {
  return vec2<f32>(
    bitcast<f32>((*packed)[0u]),
    bitcast<f32>((*packed)[1u])
  );
}
`,
};

/**
 * Get the polygon count from the packed shadow buffer.
 */
export const fn_getShadowPolygonCount: ShaderModule = {
  code: /*wgsl*/ `
fn getShadowPolygonCount(packed: ptr<storage, array<u32>, read>) -> u32 {
  return (*packed)[2u];
}
`,
};

/**
 * Read a PolygonShadowData struct from the packed shadow buffer.
 * Each polygon is 12 u32 values starting at offset 8 in the buffer.
 */
export const fn_getShadowPolygon: ShaderModule = {
  dependencies: [struct_PolygonShadowData],
  code: /*wgsl*/ `
fn getShadowPolygon(packed: ptr<storage, array<u32>, read>, index: u32) -> PolygonShadowData {
  let base = 8u + index * 12u;
  var p: PolygonShadowData;
  p.leftSilhouette = vec2<f32>(bitcast<f32>((*packed)[base + 0u]), bitcast<f32>((*packed)[base + 1u]));
  p.rightSilhouette = vec2<f32>(bitcast<f32>((*packed)[base + 2u]), bitcast<f32>((*packed)[base + 3u]));
  p.obstacleWidth = bitcast<f32>((*packed)[base + 4u]);
  p.vertexStartIndex = (*packed)[base + 5u];
  p.vertexCount = (*packed)[base + 6u];
  p._padding1 = bitcast<f32>((*packed)[base + 7u]);
  p.bboxMin = vec2<f32>(bitcast<f32>((*packed)[base + 8u]), bitcast<f32>((*packed)[base + 9u]));
  p.bboxMax = vec2<f32>(bitcast<f32>((*packed)[base + 10u]), bitcast<f32>((*packed)[base + 11u]));
  return p;
}
`,
};

/**
 * Read a shadow vertex from the packed shadow buffer.
 * Vertices are stored after the shadow data section at verticesOffset.
 */
export const fn_getShadowVertex: ShaderModule = {
  code: /*wgsl*/ `
fn getShadowVertex(packed: ptr<storage, array<u32>, read>, index: u32) -> vec2<f32> {
  let verticesOffset = (*packed)[3u];
  let base = verticesOffset + index * 2u;
  return vec2<f32>(
    bitcast<f32>((*packed)[base]),
    bitcast<f32>((*packed)[base + 1u])
  );
}
`,
};

/**
 * Test if a point is inside a shadow polygon using the winding number algorithm.
 * Reads vertices directly from the packed shadow buffer.
 *
 * Dependencies: fn_pointLeftOfSegment
 */
export const fn_isInsideShadowPolygon: ShaderModule = {
  dependencies: [fn_pointLeftOfSegment, fn_getShadowVertex],
  code: /*wgsl*/ `
fn isInsideShadowPolygon(
  worldPos: vec2<f32>,
  packed: ptr<storage, array<u32>, read>,
  startIndex: u32,
  vertexCount: u32,
) -> bool {
  var windingNumber: i32 = 0;

  for (var i: u32 = 0u; i < vertexCount; i++) {
    let a = getShadowVertex(packed, startIndex + i);
    let b = getShadowVertex(packed, startIndex + ((i + 1u) % vertexCount));

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
