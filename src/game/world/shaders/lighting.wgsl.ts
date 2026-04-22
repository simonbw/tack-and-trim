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

    // Effective sun radiance relative to the tone-mapped sky color. In
    // reality the sun's disc is ~10^4× the sky's luminance; in LDR we
    // need an explicit scale factor so specular sparkles are visible
    // against the already-bright sky. This is the one "HDR compensation"
    // knob in the otherwise-physical surface model.
    const SUN_INTENSITY: f32 = 12.0;

    // Surface micro-roughness controls how wide the sun glint lobe is.
    // Real water has tiny ripples from wind that spread the mirror
    // reflection over a much wider angle than a perfectly flat surface.
    // Smaller = wider, more sparkle; larger = sharper point highlight.
    // 64 is broad enough that gentle wave slopes light up visibly when
    // viewed from above.
    const WATER_SPECULAR_POWER: f32 = 64.0;

    // Schlick Fresnel approximation. 'facing' is dot(normal, viewDir).
    fn waterFresnel(facing: f32) -> f32 {
      let f = clamp(facing, 0.0, 1.0);
      return WATER_F0 + (1.0 - WATER_F0) * pow(1.0 - f, 5.0);
    }

    // Composite surface lighting: energy-conserving mix of transmitted
    // light and sky reflection via Fresnel, plus direct sun specular.
    //
    //   base = (1 - F) * transmitted + F * sky
    //   spec = F * SUN_INTENSITY * sunColor * pow(n·h, SPECULAR_POWER)
    //   out  = base + spec
    //
    // The specular term scales by F so the Fresnel response still shapes
    // the highlight (brighter toward grazing angles), but SUN_INTENSITY
    // compensates for LDR so sparkles are actually visible.
    fn waterSurfaceLight(
      normal: vec3<f32>,
      viewDir: vec3<f32>,
      transmitted: vec3<f32>,
      sunDir: vec3<f32>,
      sunColor: vec3<f32>,
      skyColor: vec3<f32>,
    ) -> vec3<f32> {
      let facing = max(dot(normal, viewDir), 0.0);
      let F = waterFresnel(facing);

      let base = mix(transmitted, skyColor, F);

      let halfway = normalize(sunDir + viewDir);
      let specAngle = max(dot(normal, halfway), 0.0);
      let specular = pow(specAngle, WATER_SPECULAR_POWER) * F * SUN_INTENSITY;

      return base + sunColor * specular;
    }
  `,
};
