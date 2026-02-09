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

/**
 * Wave phase speed calculation function.
 * Computes wave speed as a function of water depth.
 *
 * Deep water (depth > wavelength/2): c = sqrt(g*λ/(2π))
 * Shallow water (depth < wavelength/20): c = sqrt(g*d)
 * Intermediate: Uses full dispersion relation approximation
 */
export const fn_computeWaveSpeed: ShaderModule = {
  code: /*wgsl*/ `
    // Compute wave phase speed at a given depth
    // wavelength: wave length (feet)
    // depth: water depth (feet)
    // Returns phase speed (feet/second)
    fn computeWaveSpeed(wavelength: f32, depth: f32) -> f32 {
      let k = TWO_PI / wavelength;

      // Deep water threshold: depth > wavelength/2
      let deepWaterThreshold = wavelength * 0.5;
      if (depth >= deepWaterThreshold) {
        // Deep water: c = sqrt(g*λ/(2π))
        return sqrt(GRAVITY * wavelength / TWO_PI);
      }

      // Shallow water threshold: depth < wavelength/20
      let shallowWaterThreshold = wavelength * 0.05;
      if (depth <= shallowWaterThreshold) {
        // Shallow water: c = sqrt(g*d)
        return sqrt(GRAVITY * max(depth, 0.1));
      }

      // Intermediate depth: use tanh approximation
      // Full dispersion: ω² = g*k*tanh(k*d)
      // c = ω/k = sqrt(g*tanh(k*d)/k)
      let kd = k * depth;
      return sqrt(GRAVITY * tanh(kd) / k);
    }
  `,
};

/**
 * Wave refraction calculation function.
 * Computes direction change due to depth gradient using Snell's Law.
 *
 * Waves bend toward shallower water (slower phase speed).
 * Returns angular offset in radians to add to wave direction.
 */
export const fn_computeRefractionOffset: ShaderModule = {
  dependencies: [fn_computeWaveSpeed],
  code: /*wgsl*/ `
    // Compute refraction-induced direction offset
    // waveDir: incident wave direction (radians, 0 = east)
    // wavelength: wave length (feet)
    // depth: water depth at query point (feet)
    // depthGradient: spatial gradient of depth (∇depth, in depth units per foot)
    // Returns: angular offset in radians to add to wave direction
    fn computeRefractionOffset(
      waveDir: f32,
      wavelength: f32,
      depth: f32,
      depthGradient: vec2<f32>
    ) -> f32 {
      // Only apply refraction in intermediate depths
      let deepThreshold = wavelength * 0.5;
      let shallowThreshold = wavelength * 0.05;

      if (depth >= deepThreshold || depth <= shallowThreshold) {
        return 0.0; // Deep or very shallow - minimal refraction
      }

      // Magnitude of depth gradient
      let gradMag = length(depthGradient);
      if (gradMag < 0.001) {
        return 0.0; // Flat bottom - no refraction
      }

      // Direction of depth gradient (points toward deeper water)
      let gradDir = depthGradient / gradMag;

      // Wave direction vector
      let waveDx = cos(waveDir);
      let waveDy = sin(waveDir);
      let waveVec = vec2<f32>(waveDx, waveDy);

      // Component of wave direction perpendicular to depth gradient
      // This is the component that will be refracted
      let perpComponent = dot(waveVec, vec2<f32>(-gradDir.y, gradDir.x));

      // Estimate depth change over one wavelength in wave direction
      let depthChangeRate = dot(waveVec, gradDir) * gradMag;

      // Approximate depth at one wavelength ahead/behind
      let depthAhead = depth + depthChangeRate * wavelength;
      let depthBehind = depth - depthChangeRate * wavelength;

      // Compute speed ratio (Snell's Law: sin(θ₁)/c₁ = sin(θ₂)/c₂)
      let speedHere = computeWaveSpeed(wavelength, depth);
      let speedAhead = computeWaveSpeed(wavelength, max(depthAhead, 0.1));

      // For small angles: Δθ ≈ (Δc/c) * sin(incident_angle)
      // incident_angle is angle between wave and depth contours
      let speedRatio = (speedAhead - speedHere) / max(speedHere, 0.1);

      // Angle of wave relative to depth gradient (0 = perpendicular to contours)
      let incidentAngle = asin(clamp(abs(perpComponent), 0.0, 1.0));

      // Refraction strength: stronger in intermediate depths
      let refractionStrength = smoothstep(shallowThreshold, deepThreshold * 0.3, depth) *
                               smoothstep(deepThreshold, deepThreshold * 0.3, depth);

      // Direction offset: waves bend toward shallower water
      // Negative gradient direction points toward shallower water
      let refractionOffset = -speedRatio * sin(incidentAngle) * refractionStrength;

      // Limit maximum refraction per evaluation (prevent instability)
      return clamp(refractionOffset, -0.2, 0.2);
    }
  `,
};
