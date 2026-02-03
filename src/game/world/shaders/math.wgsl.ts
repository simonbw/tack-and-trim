/**
 * Math utility shader modules.
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";

/**
 * Hash function module for procedural noise.
 * Provides hash21 for 2D -> 1D hashing.
 */
export const hashModule: ShaderModule = {
  code: /*wgsl*/ `
    // Hash function for procedural noise (2D -> 1D)
    fn hash21(p: vec2<f32>) -> f32 {
      var q = fract(p * vec2<f32>(234.34, 435.345));
      q = q + dot(q, q + 34.23);
      return fract(q.x * q.y);
    }
  `,
};
