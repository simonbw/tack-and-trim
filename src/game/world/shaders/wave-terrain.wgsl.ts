/**
 * Wave-terrain interaction shader modules.
 *
 * Implements shoaling (waves grow taller in shallow water) and
 * damping (waves dissipate in very shallow water).
 *
 * Physics reference:
 * - Shoaling: Green's Law - H₂/H₁ = (d₁/d₂)^(1/4)
 * - Waves "feel" the bottom when depth < wavelength/2
 * - In very shallow water, waves break and lose energy
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";

/**
 * Compute shoaling factor - waves grow taller as they enter shallow water.
 *
 * Based on simplified Green's Law. The factor increases as depth decreases,
 * but only when depth < wavelength/2 (wave "feels" the bottom).
 *
 * Returns a multiplier > 1 in shallow water, ~1 in deep water.
 */
export const fn_computeShoalingFactor: ShaderModule = {
  code: /*wgsl*/ `
    fn computeShoalingFactor(depth: f32, wavelength: f32) -> f32 {
      // Waves feel bottom when depth < wavelength/2
      let transitionDepth = wavelength * 0.5;

      // In deep water, no shoaling
      if (depth >= transitionDepth) {
        return 1.0;
      }

      // Prevent division by zero and extreme values
      let safeDepth = max(depth, 0.5);

      // Green's Law: H₂/H₁ = (d₁/d₂)^(1/4)
      // We use transitionDepth as reference depth d₁
      // Factor = (transitionDepth / depth)^0.25
      let rawFactor = pow(transitionDepth / safeDepth, 0.25);

      // Clamp to reasonable range (max 2x amplitude)
      return clamp(rawFactor, 0.0, 2.0);
    }
  `,
};

/**
 * Compute damping factor - waves lose energy in very shallow water.
 *
 * This represents wave breaking and bottom friction. Without damping,
 * shoaling would cause infinite wave heights at the shoreline.
 *
 * Waves are allowed to extend slightly above the terrain (negative depth)
 * to create a natural swash zone where waves wash up and down the shore.
 *
 * Returns a multiplier 0-1, approaching 0 as depth decreases.
 */
export const fn_computeDampingFactor: ShaderModule = {
  code: /*wgsl*/ `
    fn computeDampingFactor(depth: f32, wavelength: f32) -> f32 {
      // Damping threshold - waves start breaking when depth < wavelength/20
      let dampingThreshold = wavelength * 0.05;

      // Allow waves to extend into negative depth (above terrain).
      // The swash zone lets wave crests wash up onto the shore.
      let swashDepth = wavelength * 0.05;

      // Smooth falloff from full energy to zero, centered so it
      // reaches zero at -swashDepth rather than at depth=0
      return smoothstep(-swashDepth, dampingThreshold, depth);
    }
  `,
};

/**
 * Combined wave-terrain energy modifier.
 *
 * Combines shoaling (amplitude increase) and damping (amplitude decrease)
 * into a single factor. This should be multiplied with the wave's energy factor.
 *
 * The combined effect:
 * - Deep water (depth > wavelength/2): factor ≈ 1.0
 * - Shallow water: factor increases (shoaling)
 * - Very shallow water: factor decreases (damping dominates)
 */
export const fn_computeWaveTerrainFactor: ShaderModule = {
  dependencies: [fn_computeShoalingFactor, fn_computeDampingFactor],
  code: /*wgsl*/ `
    fn computeWaveTerrainFactor(depth: f32, wavelength: f32) -> f32 {
      // Handle NaN
      if (depth != depth) {
        return 0.0;
      }

      // Damping handles negative depth gracefully (swash zone),
      // so we only need shoaling for positive depth
      let shoaling = select(1.0, computeShoalingFactor(depth, wavelength), depth > 0.0);
      let damping = computeDampingFactor(depth, wavelength);

      return shoaling * damping;
    }
  `,
};
