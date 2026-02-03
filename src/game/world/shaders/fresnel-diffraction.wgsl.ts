/**
 * Fresnel diffraction shader module.
 * Physical model for wave energy attenuation behind obstacles.
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";

/**
 * Fresnel diffraction module for wave shadow computation.
 * Computes wave energy attenuation using Fresnel diffraction theory.
 *
 * Based on Fresnel diffraction in the transition zone between geometric
 * shadow and illuminated regions. Uses the Fresnel parameter to determine
 * how much wave energy diffracts into the shadow zone.
 */
export const fresnelDiffractionModule: ShaderModule = {
  code: /*wgsl*/ `
    // Compute wave energy attenuation from Fresnel diffraction
    // distanceToShadowBoundary: perpendicular distance to shadow edge (feet)
    // distanceBehindObstacle: distance along wave direction from obstacle (feet)
    // wavelength: wave wavelength (feet)
    // Returns energy factor (0.0 = full shadow, 1.0 = full energy)
    fn computeFresnelEnergy(
      distanceToShadowBoundary: f32,
      distanceBehindObstacle: f32,
      wavelength: f32,
    ) -> f32 {
      // Prevent division by zero very close to obstacle
      let z = max(distanceBehindObstacle, 1.0);

      // Fresnel parameter: u = d * sqrt(2 / (λ * z))
      // where d is distance to shadow boundary
      let u = distanceToShadowBoundary * sqrt(2.0 / (wavelength * z));

      // Deep shadow region (far from boundary)
      if (u > 4.0) {
        return 0.0;
      }

      // Transition zone - use tanh approximation of erf
      // Error function (erf) determines diffraction intensity
      // tanh provides fast approximation: erf(x) ≈ tanh(x * 1.128)
      let t = u * 0.7; // ERF_APPROX_COEFF = 0.7
      let erfApprox = tanh(t * 1.128);

      // Fresnel integral approximation
      // Returns value in [0, 1] representing energy in shadow zone
      return 0.5 * (1.0 - erfApprox);
    }
  `,
};
