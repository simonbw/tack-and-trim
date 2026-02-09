/**
 * Math utility shader modules.
 *
 * Note: PI, TWO_PI, HALF_PI, and GRAVITY are automatically included
 * by the base Shader class via getMathConstants(). No need to import them.
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";

/**
 * Hash function for procedural noise (2D -> 1D).
 */
export const fn_hash21: ShaderModule = {
  code: /*wgsl*/ `
    // Hash function for procedural noise (2D -> 1D)
    fn hash21(p: vec2<f32>) -> f32 {
      var q = fract(p * vec2<f32>(234.34, 435.345));
      q = q + dot(q, q + 34.23);
      return fract(q.x * q.y);
    }
  `,
};
