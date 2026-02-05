/**
 * Sand surface rendering shader module.
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";

/**
 * Sand rendering module with wetness support.
 * Renders beach/sand surfaces with dry/wet color transitions.
 */
export const fn_renderSand: ShaderModule = {
  code: /*wgsl*/ `
    // Render sand surface with wetness
    // height: terrain height (world units)
    // normal: surface normal
    // worldPos: world position (for variation)
    // wetness: wetness factor (0.0 = dry, 1.0 = wet)
    // Returns RGB color
    fn renderSand(height: f32, normal: vec3<f32>, worldPos: vec2<f32>, wetness: f32) -> vec3<f32> {
      // Dry sand - light beige
      let drySand = vec3<f32>(0.96, 0.91, 0.76);
      // Wet sand - darker tan
      let wetSand = vec3<f32>(0.76, 0.70, 0.50);

      // Non-linear blend: changes quickly at first, then slowly as it dries
      // pow(wetness, 2.5) means high wetness drops fast visually, low wetness lingers
      let visualWetness = pow(wetness, 2.5);

      return mix(drySand, wetSand, visualWetness);
    }
  `,
};
