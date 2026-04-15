/**
 * Global scene lighting functions.
 * Sun direction and colors dynamically calculated from time of day.
 * Shared across all surface materials.
 */
import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";

// Constants for time calculations
const SECONDS_PER_HOUR = 3600;

export const fn_SCENE_LIGHTING: ShaderModule = {
  code: /*wgsl*/ `
    // Time constants
    const SECONDS_PER_HOUR: f32 = ${SECONDS_PER_HOUR}.0;

    // Raw (unclamped) sun altitude in [-1, 1]: +1 at zenith, 0 at horizon,
    // -1 at nadir. Daytime is altitude > 0, night is altitude < 0.
    fn getSunAltitude(time: f32) -> f32 {
      let hour = time / SECONDS_PER_HOUR;
      let sunPhase = (hour - 6.0) * 3.14159 / 12.0; // 6am..6pm maps to 0..π
      return sin(sunPhase);
    }

    // Calculate sun direction from time of day
    // time: time in seconds since midnight (0-86400)
    // Returns normalized vector pointing toward the sun
    fn getSunDirection(time: f32) -> vec3<f32> {
      let hour = time / SECONDS_PER_HOUR;
      let sunElevation = max(getSunAltitude(time), 0.0);

      // Sun azimuth: rises in east (-Y), sets in west (+Y)
      // At noon, sun is south (+X direction in our coordinate system)
      let azimuth = (hour - 12.0) * 3.14159 / 6.0; // Noon = 0, sweeps east to west

      // X: south/north, Y: east/west, Z: up/down
      let x = cos(azimuth) * 0.3 + 0.3;
      let y = sin(azimuth) * 0.2 + 0.2;
      let z = sunElevation * 0.9 + 0.1;

      return normalize(vec3<f32>(x, y, z));
    }

    // Calculate sun color from time of day.
    // Returns (0,0,0) when the sun is below the horizon — no direct sunlight
    // at night. Near the horizon the color is warm orange/red from atmospheric
    // scattering; high in the sky it's nearly white.
    fn getSunColor(time: f32) -> vec3<f32> {
      let altitude = getSunAltitude(time);

      // Sun visible at all: ramps in as the sun clears the horizon
      let sunVisible = smoothstep(-0.02, 0.08, altitude);

      // Warmth: high near horizon (long atmospheric path), cool overhead
      let warmth = 1.0 - smoothstep(0.0, 0.4, altitude);
      let warmColor = vec3<f32>(1.0, 0.55, 0.25); // Sunrise/sunset red-orange
      let whiteColor = vec3<f32>(1.0, 0.95, 0.85); // Midday warm-white

      return mix(whiteColor, warmColor, warmth) * sunVisible;
    }

    // Calculate sky color from time of day.
    // Three regimes blended by sun altitude:
    //   - Night: deep blue-black, ambient moon/starlight only
    //   - Twilight (sun near horizon): warm glow added to the base
    //   - Day: bright blue
    fn getSkyColor(time: f32) -> vec3<f32> {
      let altitude = getSunAltitude(time);

      // Night → day base transition.
      // nightSky is tuned for a full-moon-lit night: the moon reflects ~12%
      // of sunlight (albedo), and after tone mapping for LDR the moonlit sky
      // reads as a muted cool blue — visible but clearly nocturnal. For a
      // moonless night, drop to (0.01, 0.02, 0.05).
      let dayness = smoothstep(-0.1, 0.25, altitude);
      let nightSky = vec3<f32>(0.06, 0.09, 0.16); // Full-moon night
      let daySky = vec3<f32>(0.5, 0.7, 0.95);     // Bright midday blue
      let baseSky = mix(nightSky, daySky, dayness);

      // Twilight glow: Gaussian bump centered at the horizon
      let twilightBump = exp(-altitude * altitude * 40.0);
      let twilightColor = vec3<f32>(0.55, 0.28, 0.25); // Warm red-orange

      return baseSky + twilightColor * twilightBump * 0.35;
    }
  `,
};
