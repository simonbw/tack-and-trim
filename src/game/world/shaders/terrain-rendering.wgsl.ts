/**
 * Procedural terrain surface rendering shader module.
 *
 * Replaces the flat sand renderer with biome-aware terrain coloring
 * based on elevation zones, slope, noise variation, and optional snow.
 *
 * Scene-lighting values (sun direction, sun color) come from the caller's
 * uniform buffer — populated once per frame by `TimeOfDay`.
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";
import { fn_simplex3D } from "./noise.wgsl";

/**
 * Terrain rendering module with biome support.
 * Renders terrain surfaces with elevation-based coloring, slope-dependent
 * rock exposure, optional snow, and multi-scale noise variation.
 */
export const fn_renderTerrain: ShaderModule = {
  preamble: /*wgsl*/ `
    struct BiomeZone {
      colorAndHeight: vec4<f32>,
      altColorAndBlend: vec4<f32>,
    }

    struct BiomeParams {
      zones: array<BiomeZone, 6>,
      rockColorAndThreshold: vec4<f32>,
      snowColorAndLine: vec4<f32>,
      noiseScales: vec2<f32>,
      zoneCount: u32,
      _pad: u32,
    }
  `,
  bindings: {
    biomeParams: { type: "uniform" as const, wgslType: "BiomeParams" },
  },
  code: /*wgsl*/ `
    // Render terrain surface with biome-based coloring.
    // height: terrain height (world units, feet)
    // normal: surface normal
    // worldPos: world position (for noise sampling)
    // wetness: wetness factor (0.0 = dry, 1.0 = wet)
    // sunDir: normalized direction toward the sun (from scene lighting)
    // sunColor: direct sunlight RGB — (0,0,0) at night
    // skyColor: ambient sky/moonlight RGB — bluish at day, dim blue at night
    // Returns RGB color.
    fn renderTerrain(
      height: f32,
      normal: vec3<f32>,
      worldPos: vec2<f32>,
      wetness: f32,
      sunDir: vec3<f32>,
      sunColor: vec3<f32>,
      skyColor: vec3<f32>,
    ) -> vec3<f32> {
      let zoneCount = biomeParams.zoneCount;

      // Multi-scale noise for zone boundary perturbation and within-zone variation.
      // Use different z-offsets so the two noise fields are uncorrelated.
      let largeNoise = simplex3D(vec3<f32>(worldPos * biomeParams.noiseScales.x, 0.0));
      let smallNoise = simplex3D(vec3<f32>(worldPos * biomeParams.noiseScales.y, 3.7));

      // Remap noise from [-1,1] to [0,1]
      let largeNoiseT = largeNoise * 0.5 + 0.5;

      // Find the zone this height falls in, with noise-perturbed boundaries.
      var zoneIdx = 0u;
      for (var i = 0u; i < zoneCount; i = i + 1u) {
        let boundary = biomeParams.zones[i].colorAndHeight.w;
        let perturbAmount = min(boundary * 0.15, 15.0);
        let perturbedBoundary = boundary + largeNoise * perturbAmount;
        if (height < perturbedBoundary) {
          zoneIdx = i;
          break;
        }
        zoneIdx = i;
      }

      // Compute color for a zone with noise variation
      let zone = biomeParams.zones[zoneIdx];
      let baseColor = zone.colorAndHeight.rgb;
      let altColor = zone.altColorAndBlend.rgb;
      let noiseBlend = zone.altColorAndBlend.w;
      var color = mix(baseColor, altColor, largeNoiseT * noiseBlend);

      // Blend with the zone below at the lower boundary.
      // Measure how far above the lower boundary we are and fade toward it.
      if (zoneIdx > 0u) {
        let lowerBoundary = biomeParams.zones[zoneIdx - 1u].colorAndHeight.w;
        let perturbAmount = min(lowerBoundary * 0.15, 15.0);
        let perturbedLower = lowerBoundary + largeNoise * perturbAmount;
        let distAboveLower = height - perturbedLower;
        let transitionWidth = max(lowerBoundary * 0.3, 8.0);
        if (distAboveLower < transitionWidth) {
          let t = smoothstep(0.0, 1.0, distAboveLower / transitionWidth);
          let prevZone = biomeParams.zones[zoneIdx - 1u];
          let prevColor = mix(prevZone.colorAndHeight.rgb, prevZone.altColorAndBlend.rgb, largeNoiseT * prevZone.altColorAndBlend.w);
          color = mix(prevColor, color, t);
        }
      }

      // Slope-dependent rock exposure
      let slope = 1.0 - normal.z;
      let rockThreshold = biomeParams.rockColorAndThreshold.w;
      let rockBlend = smoothstep(rockThreshold - 0.1, rockThreshold + 0.1, slope);
      color = mix(color, biomeParams.rockColorAndThreshold.rgb, rockBlend);

      // Snow above snowline (if enabled)
      let snowline = biomeParams.snowColorAndLine.w;
      if (snowline >= 0.0) {
        // Noise-perturbed snowline
        let snowNoise = largeNoise * 20.0;
        var snowBlend = smoothstep(snowline - 10.0, snowline + 10.0, height + snowNoise);
        // Reduce snow on steep slopes (snow slides off cliffs)
        let slopeSnowReduction = smoothstep(0.3, 0.6, slope);
        snowBlend = snowBlend * (1.0 - slopeSnowReduction);
        color = mix(color, biomeParams.snowColorAndLine.rgb, snowBlend);
      }

      // Wetness darkening near waterline
      let visualWetness = pow(wetness, 2.5);
      let wetColor = color * 0.75;
      color = mix(color, wetColor, visualWetness);

      // Ambient (sky) + directional (sun·normal) illumination. Sky provides
      // the cool-blue moonlit floor at night; sun adds warm directional
      // brightness during the day.
      let diffuse = max(dot(normal, sunDir), 0.0);
      let ambient = 0.5;
      let illumination = skyColor * ambient + sunColor * diffuse;
      return color * illumination;
    }
  `,
  dependencies: [fn_simplex3D],
};
