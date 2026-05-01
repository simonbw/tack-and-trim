/**
 * IDW (Inverse Distance Weighting) interpolation helpers.
 *
 * Small, reusable WGSL helpers for computing weights from distances and
 * blending two values using IDW. Higher-level terrain interpolation in
 * `terrain.wgsl` inlines these formulas directly for performance, but the
 * helpers are exposed here for any future consumer that wants to compose
 * IDW blending from primitives.
 *
 * Naming convention:
 * - `fn_` prefix for function modules
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";

/**
 * Compute IDW weight from distance.
 * Uses 1/distance weighting with minimum distance clamp.
 */
export const fn_computeIDWWeight: ShaderModule = {
  code: /*wgsl*/ `
    fn computeIDWWeight(distance: f32, minDist: f32) -> f32 {
      return 1.0 / max(distance, minDist);
    }
  `,
};

/**
 * Blend two values using IDW.
 * Returns weighted average of value1 and value2.
 */
export const fn_blendIDW: ShaderModule = {
  code: /*wgsl*/ `
    fn blendIDW(value1: f32, weight1: f32, value2: f32, weight2: f32) -> f32 {
      let totalWeight = weight1 + weight2;
      return (value1 * weight1 + value2 * weight2) / totalWeight;
    }
  `,
};
