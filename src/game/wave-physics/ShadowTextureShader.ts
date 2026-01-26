/**
 * Shadow Texture Shader
 *
 * Simple vertex/fragment shader for rendering shadow polygons to a texture.
 * - Vertex shader: transforms polygon vertices from world space to clip space
 * - Fragment shader: outputs polygon index as r8uint
 *
 * This shader is used by ShadowTextureRenderer to create a binary shadow mask
 * where each pixel contains either 0 (not in shadow) or a polygon index (1+).
 */

/**
 * WGSL vertex shader code.
 * Transforms world-space polygon vertices to clip space based on viewport.
 */
export const SHADOW_TEXTURE_VERTEX_SHADER = /*wgsl*/ `
struct Uniforms {
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexInput {
  @location(0) position: vec2<f32>,
  @location(1) polygonIndex: u32,
}

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) @interpolate(flat) polygonIndex: u32,
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;

  // Transform world position to normalized device coordinates (0 to 1)
  let normalizedX = (input.position.x - uniforms.viewportLeft) / uniforms.viewportWidth;
  let normalizedY = (input.position.y - uniforms.viewportTop) / uniforms.viewportHeight;

  // Convert to clip space (-1 to 1)
  // Flip Y so texture is right-side-up relative to world coordinates
  // (WebGPU clip Y=-1 is top, but we want low worldY at texture bottom)
  let clipX = normalizedX * 2.0 - 1.0;
  let clipY = 1.0 - normalizedY * 2.0;

  output.clipPosition = vec4<f32>(clipX, clipY, 0.0, 1.0);
  output.polygonIndex = input.polygonIndex;

  return output;
}
`;

/**
 * WGSL fragment shader code.
 * Outputs the polygon index as an unsigned integer.
 */
export const SHADOW_TEXTURE_FRAGMENT_SHADER = /*wgsl*/ `
struct FragmentInput {
  @location(0) @interpolate(flat) polygonIndex: u32,
}

@fragment
fn fs_main(input: FragmentInput) -> @location(0) u32 {
  // Output polygon index + 1 (so 0 means "not in shadow")
  return input.polygonIndex + 1u;
}
`;

/**
 * Combined shader code for the render pipeline.
 */
export const SHADOW_TEXTURE_SHADER_CODE =
  SHADOW_TEXTURE_VERTEX_SHADER + "\n" + SHADOW_TEXTURE_FRAGMENT_SHADER;
