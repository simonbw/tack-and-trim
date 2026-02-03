/**
 * Coordinate transformation shader modules.
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";

/**
 * Viewport coordinate conversion module.
 * Provides functions for converting between UV (0-1) and world coordinates.
 */
export const viewportModule: ShaderModule = {
  code: /*wgsl*/ `
    // Convert UV (0-1) to world position using viewport
    fn uvToWorld(uv: vec2<f32>, viewportLeft: f32, viewportTop: f32, viewportWidth: f32, viewportHeight: f32) -> vec2<f32> {
      return vec2<f32>(
        viewportLeft + uv.x * viewportWidth,
        viewportTop + uv.y * viewportHeight
      );
    }

    // Convert world position to UV (0-1) using viewport
    fn worldToUV(worldPos: vec2<f32>, viewportLeft: f32, viewportTop: f32, viewportWidth: f32, viewportHeight: f32) -> vec2<f32> {
      return vec2<f32>(
        (worldPos.x - viewportLeft) / viewportWidth,
        (worldPos.y - viewportTop) / viewportHeight
      );
    }

    // Check if UV is within valid bounds (0-1 range)
    fn uvInBounds(uv: vec2<f32>) -> bool {
      return uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
    }
  `,
};
