/**
 * Lighting shader modules.
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";
import { fn_SCENE_LIGHTING } from "./scene-lighting.wgsl";

/**
 * Fresnel effect calculation module.
 * Provides computeFresnel for view-dependent reflectance.
 */
export const fn_computeFresnel: ShaderModule = {
  code: /*wgsl*/ `
    // Compute Fresnel effect (Schlick approximation)
    // facing: dot product of normal and view direction (0 = perpendicular, 1 = head-on)
    // power: controls falloff (higher = sharper fresnel rim)
    fn computeFresnel(facing: f32, power: f32) -> f32 {
      return pow(1.0 - facing, power);
    }
  `,
};

/**
 * Specular lighting calculation module.
 * Provides computeSpecular for mirror-like reflections.
 */
export const fn_computeSpecular: ShaderModule = {
  code: /*wgsl*/ `
    // Compute Phong specular reflection
    // viewDir: direction from surface to viewer
    // normal: surface normal
    // lightDir: direction from surface to light
    // shininess: specular exponent (higher = tighter highlight)
    fn computeSpecular(viewDir: vec3<f32>, normal: vec3<f32>, lightDir: vec3<f32>, shininess: f32) -> f32 {
      let reflectDir = reflect(-lightDir, normal);
      return pow(max(dot(viewDir, reflectDir), 0.0), shininess);
    }
  `,
};

/**
 * Diffuse lighting calculation module.
 * Provides computeDiffuse for matte surface lighting.
 */
export const fn_computeDiffuse: ShaderModule = {
  code: /*wgsl*/ `
    // Compute Lambertian diffuse lighting
    // normal: surface normal
    // lightDir: direction from surface to light
    fn computeDiffuse(normal: vec3<f32>, lightDir: vec3<f32>) -> f32 {
      return max(dot(normal, lightDir), 0.0);
    }
  `,
};

/**
 * Complete water lighting module combining all lighting effects.
 * Provides renderWaterLighting for full water surface shading.
 */
export const fn_renderWaterLighting: ShaderModule = {
  code: /*wgsl*/ `
    // Compute complete water lighting
    // normal: water surface normal
    // viewDir: direction from surface to viewer
    // rawHeight: normalized wave height (0-1)
    // waterDepth: depth of water in world units
    // time: time in seconds since midnight (for sun position/color)
    fn renderWaterLighting(
      normal: vec3<f32>,
      viewDir: vec3<f32>,
      rawHeight: f32,
      waterDepth: f32,
      time: f32
    ) -> vec3<f32> {
      // Calculate sun direction and colors from time of day
      let sunDir = getSunDirection(time);
      let sunColor = getSunColor(time);
      let skyColor = getSkyColor(time);

      // Water colors - vary by depth
      let shallowWater = vec3<f32>(0.15, 0.55, 0.65);  // Light blue-green
      let deepWater = vec3<f32>(0.08, 0.32, 0.52);     // Darker blue
      let scatterColor = vec3<f32>(0.1, 0.45, 0.55);

      // Depth-based color (deeper = darker/more blue)
      let depthFactor = smoothstep(0.0, 10.0, waterDepth);
      var baseColor = mix(shallowWater, deepWater, depthFactor);

      // Slope-based color variation
      let sunFacing = dot(normal.xy, sunDir.xy);
      let slopeShift = mix(
        vec3<f32>(-0.02, -0.01, 0.02),
        vec3<f32>(0.02, 0.03, -0.01),
        sunFacing * 0.5 + 0.5
      );
      baseColor = baseColor + slopeShift * 0.08;

      // Troughs are darker
      let troughDarken = (1.0 - rawHeight) * 0.12;
      baseColor = baseColor * (1.0 - troughDarken);

      // Fresnel effect
      let facing = dot(normal, viewDir);
      let fresnel = computeFresnel(facing, 4.0) * 0.15;

      // Subsurface scattering
      let scatter = computeDiffuse(normal, sunDir) * (0.5 + 0.5 * rawHeight);
      let subsurface = scatterColor * scatter * 0.1;

      // Diffuse lighting
      let diffuse = computeDiffuse(normal, sunDir);

      // Specular
      let specular = computeSpecular(viewDir, normal, sunDir, 64.0);

      // Combine lighting
      let ambient = baseColor * 0.75;
      let diffuseLight = baseColor * sunColor * diffuse * 0.15;
      let skyReflection = skyColor * fresnel * 0.1;
      let specularLight = sunColor * specular * 0.08;

      return ambient + subsurface + diffuseLight + skyReflection + specularLight;
    }
  `,
  dependencies: [
    fn_SCENE_LIGHTING,
    fn_computeFresnel,
    fn_computeSpecular,
    fn_computeDiffuse,
  ],
};
