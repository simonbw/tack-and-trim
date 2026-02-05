/**
 * Wave physics shader modules.
 * Physical formulas for water wave behavior.
 *
 * Note: GRAVITY and PI constants are automatically included
 * by the base Shader class via getMathConstants(). No need to import them.
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";

/**
 * Green's Law shoaling function.
 * Computes wave amplitude change in shallow water.
 *
 * Based on Green's Law which states that wave amplitude increases as depth decreases
 * to conserve energy flux.
 */
export const fn_computeShoalingFactor: ShaderModule = {
  code: /*wgsl*/ `
    // Green's Law shoaling factor
    // Computes wave amplitude amplification in shallow water
    // Returns multiplier for wave amplitude (1.0 = no change, >1.0 = amplified)
    fn computeShoalingFactor(waterDepth: f32, wavelength: f32) -> f32 {
      let DEEP_WATER_DEPTH: f32 = 100.0;
      let MIN_DEPTH: f32 = 2.0;
      let shallowThreshold = wavelength * 0.5;

      if (waterDepth > shallowThreshold) {
        return 1.0;
      }

      let shallowFactor = 1.0 - smoothstep(shallowThreshold * 0.5, shallowThreshold, waterDepth);
      let effectiveDepth = max(waterDepth, MIN_DEPTH);
      let greenFactor = pow(DEEP_WATER_DEPTH / effectiveDepth, 0.25);
      let maxShoaling = 2.0;

      return 1.0 + (min(greenFactor, maxShoaling) - 1.0) * shallowFactor;
    }
  `,
};

/**
 * Shallow water damping function.
 * Computes bottom friction effects on waves.
 *
 * Waves lose energy due to bottom friction in shallow water.
 */
export const fn_computeShallowDamping: ShaderModule = {
  code: /*wgsl*/ `
    // Bottom friction damping factor
    // Computes wave energy loss in shallow water
    // Returns multiplier for wave amplitude (1.0 = no damping, <1.0 = damped)
    fn computeShallowDamping(waterDepth: f32) -> f32 {
      let DEEP_THRESHOLD: f32 = 10.0;
      let SHALLOW_THRESHOLD: f32 = 2.0;
      let MIN_DAMPING: f32 = 0.2;

      if (waterDepth >= DEEP_THRESHOLD) {
        return 1.0;
      }
      if (waterDepth <= SHALLOW_THRESHOLD) {
        return MIN_DAMPING;
      }

      return mix(MIN_DAMPING, 1.0, (waterDepth - SHALLOW_THRESHOLD) / (DEEP_THRESHOLD - SHALLOW_THRESHOLD));
    }
  `,
};

/**
 * Wave frequency calculation function.
 * Computes angular frequency from wavelength (deep water approximation).
 * omega = sqrt(g * k) where k = 2*PI/wavelength
 */
export const fn_computeWaveFrequency: ShaderModule = {
  code: /*wgsl*/ `
    // Compute wave angular frequency from wavelength (deep water)
    // omega = sqrt(g * k) where k = 2*PI/wavelength
    fn computeWaveFrequency(wavelength: f32) -> f32 {
      let k = (2.0 * PI) / wavelength;
      return sqrt(GRAVITY * k);
    }
  `,
};

/**
 * Wave number calculation function.
 * Computes wave number from wavelength.
 */
export const fn_computeWaveNumber: ShaderModule = {
  code: /*wgsl*/ `
    // Compute wave number from wavelength
    fn computeWaveNumber(wavelength: f32) -> f32 {
      return (2.0 * PI) / wavelength;
    }
  `,
};
