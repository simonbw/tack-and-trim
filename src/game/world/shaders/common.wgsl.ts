/**
 * Common shader modules shared across terrain, water, and wind systems.
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";

/**
 * Query point structure used by all query shaders.
 * Defines a world position to sample data at.
 */
export const queryPointsModule: ShaderModule = {
  code: /*wgsl*/ `
    struct QueryPoint {
      pos: vec2<f32>,
    }
  `,
  bindings: {
    queryPoints: {
      type: "storage",
      wgslType: "array<QueryPoint>",
    },
  },
};
