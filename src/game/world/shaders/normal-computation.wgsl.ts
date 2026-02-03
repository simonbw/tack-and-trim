/**
 * Surface normal computation shader module.
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";

/**
 * Normal computation module for height field surfaces.
 * Computes surface normals from height texture gradients.
 */
export const normalComputationModule: ShaderModule = {
  code: /*wgsl*/ `
    // Compute surface normal from height field gradients
    // uv: texture coordinates
    // texelSizeX: 1.0 / texture width
    // texelSizeY: 1.0 / texture height
    // heightTexture: height field texture
    // heightSampler: texture sampler
    // heightScale: gradient scaling factor (affects normal slope)
    // Returns normalized surface normal
    fn computeNormalFromHeightField(
      uv: vec2<f32>,
      texelSizeX: f32,
      texelSizeY: f32,
      heightTexture: texture_2d<f32>,
      heightSampler: sampler,
      heightScale: f32
    ) -> vec3<f32> {
      // Sample neighboring heights
      let heightL = textureSample(heightTexture, heightSampler, uv + vec2<f32>(-texelSizeX, 0.0)).r;
      let heightR = textureSample(heightTexture, heightSampler, uv + vec2<f32>(texelSizeX, 0.0)).r;
      let heightD = textureSample(heightTexture, heightSampler, uv + vec2<f32>(0.0, -texelSizeY)).r;
      let heightU = textureSample(heightTexture, heightSampler, uv + vec2<f32>(0.0, texelSizeY)).r;

      // Compute gradients (central differences)
      let dhdx = (heightL - heightR) * heightScale;
      let dhdy = (heightD - heightU) * heightScale;

      // Normal is cross product of tangent vectors
      // Tangent X: (1, 0, dhdx), Tangent Y: (0, 1, dhdy)
      // Cross product: (-dhdx, -dhdy, 1)
      return normalize(vec3<f32>(dhdx, dhdy, 1.0));
    }
  `,
};
