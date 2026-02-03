/**
 * Wave physics shader modules.
 * Physical formulas for water wave behavior.
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";

/**
 * Wave physics constants module.
 */
export const wavePhysicsConstantsModule: ShaderModule = {
  code: /*wgsl*/ `
    const GRAVITY: f32 = 32.174; // ft/s^2
  `,
};

/**
 * Green's Law shoaling module.
 * Provides computeShoalingFactor for wave amplitude change in shallow water.
 *
 * Based on Green's Law which states that wave amplitude increases as depth decreases
 * to conserve energy flux.
 */
export const shoalingModule: ShaderModule = {
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
 * Shallow water damping module.
 * Provides computeShallowDamping for bottom friction effects.
 *
 * Waves lose energy due to bottom friction in shallow water.
 */
export const shallowDampingModule: ShaderModule = {
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
 * Wave dispersion relation module.
 * Provides wave frequency calculation from wavelength (deep water approximation).
 */
export const waveDispersionModule: ShaderModule = {
  code: /*wgsl*/ `
    // Compute wave angular frequency from wavelength (deep water)
    // omega = sqrt(g * k) where k = 2*PI/wavelength
    fn computeWaveFrequency(wavelength: f32) -> f32 {
      let k = (2.0 * PI) / wavelength;
      return sqrt(GRAVITY * k);
    }

    // Compute wave number from wavelength
    fn computeWaveNumber(wavelength: f32) -> f32 {
      return (2.0 * PI) / wavelength;
    }
  `,
  dependencies: [wavePhysicsConstantsModule],
};
