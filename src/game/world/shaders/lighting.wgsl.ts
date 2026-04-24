/**
 * Water surface lighting module.
 *
 * Physically-based surface reflection at the air-water interface:
 *   - Schlick Fresnel mixing the transmitted light with the sky color
 *   - Direct sun specular highlight
 *
 * The transmitted light (absorbed scene + inscatter) is computed by the
 * caller; this module only handles what happens at the water surface.
 *
 * Scene-lighting values (sun direction, sun color, sky color) come from
 * the caller's uniform buffer — populated once per frame by `TimeOfDay`.
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";

export const fn_waterSurfaceLight: ShaderModule = {
  code: /*wgsl*/ `
    // Reflectance of the air-water interface at normal incidence.
    // F0 = ((n1 - n2) / (n1 + n2))^2 with n_air = 1.0, n_water = 1.333
    //    ≈ 0.0204. Real ocean water at normal incidence reflects ~2%.
    const WATER_F0: f32 = 0.02;

    // Schlick Fresnel approximation. 'facing' is dot(normal, viewDir).
    fn waterFresnel(facing: f32) -> f32 {
      let f = clamp(facing, 0.0, 1.0);
      return WATER_F0 + (1.0 - WATER_F0) * pow(1.0 - f, 5.0);
    }

    // Composite surface lighting: energy-conserving mix of transmitted
    // light and a reflection-vector-derived sky color via Fresnel, plus
    // direct sun specular.
    //
    //   reflDir   = reflect(-viewDir, normal)
    //   pixelSky  = mix(zenithSky, horizonSky, 1 - reflDir.z)
    //   base      = (1 - F) * transmitted + F * pixelSky
    //   spec      = F * SUN_INTENSITY * sunColor * pow(n·h, specularPower)
    //   out       = base + spec
    //
    // The two-tone sky picks horizon color when the wave face tilts
    // sideways (reflection points toward horizon → warmer, brighter)
    // and zenith color when the surface is flat (reflection straight up
    // → cooler, deeper blue).
    //
    // specularPower controls the sun glint lobe width and varies per pixel
    // with local wind speed: low wind → mirror-sharp (~512), high wind →
    // broad scattered glare (~16). See WaterFilterShader.ts.
    fn waterSurfaceLight(
      normal: vec3<f32>,
      viewDir: vec3<f32>,
      transmitted: vec3<f32>,
      sunDir: vec3<f32>,
      sunColor: vec3<f32>,
      zenithSkyColor: vec3<f32>,
      horizonSkyColor: vec3<f32>,
      specularPower: f32,
      sunIntensity: f32,
    ) -> vec3<f32> {
      let facing = max(dot(normal, viewDir), 0.0);
      let F = waterFresnel(facing);

      // Two-tone sky: zenithward reflection → cool blue, horizonward
      // reflection → warm bright. reflect() flips the incoming -viewDir
      // about the normal; reflDir.z is +1 for a flat surface and falls
      // toward 0 as the wave face tilts.
      let reflDir = reflect(-viewDir, normal);
      let zenithFactor = clamp(reflDir.z, 0.0, 1.0);
      let pixelSkyColor = mix(horizonSkyColor, zenithSkyColor, zenithFactor);

      let base = mix(transmitted, pixelSkyColor, F);

      let halfway = normalize(sunDir + viewDir);
      let specAngle = max(dot(normal, halfway), 0.0);
      let specular = pow(specAngle, specularPower) * F * sunIntensity;

      return base + sunColor * specular;
    }
  `,
};
