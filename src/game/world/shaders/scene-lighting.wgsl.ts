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

    // Calculate sun direction from time of day
    // time: time in seconds since midnight (0-86400)
    // Returns normalized vector pointing toward the sun
    fn getSunDirection(time: f32) -> vec3<f32> {
      // Convert time to hours (0-24)
      let hour = time / SECONDS_PER_HOUR;

      // Sun angle: rises at 6am, peaks at noon, sets at 6pm
      // Map hour to sun elevation angle (0 = horizon, 90 = zenith)
      // Use a simple sinusoid centered at noon
      let hoursSinceMidnight = hour;
      let sunPhase = (hoursSinceMidnight - 6.0) * 3.14159 / 12.0; // 6am to 6pm = 0 to PI
      let elevation = sin(sunPhase); // -1 to 1, clamped below

      // Clamp to nighttime (sun below horizon)
      let sunElevation = max(elevation, 0.0);

      // Sun azimuth: rises in east (-Y), sets in west (+Y)
      // At noon, sun is south (+X direction in our coordinate system)
      let azimuth = (hoursSinceMidnight - 12.0) * 3.14159 / 6.0; // Noon = 0, sweeps east to west

      // Convert spherical coordinates to Cartesian
      // X: south/north, Y: east/west, Z: up/down
      let x = cos(azimuth) * 0.3 + 0.3; // Bias toward south
      let y = sin(azimuth) * 0.2 + 0.2; // Bias toward west
      let z = sunElevation * 0.9 + 0.1; // Elevation (higher = more overhead)

      return normalize(vec3<f32>(x, y, z));
    }

    // Calculate sun color from time of day
    // time: time in seconds since midnight (0-86400)
    // Returns RGB color of sunlight
    fn getSunColor(time: f32) -> vec3<f32> {
      let hour = time / SECONDS_PER_HOUR;
      let sunPhase = (hour - 6.0) * 3.14159 / 12.0;
      let elevation = max(sin(sunPhase), 0.0);

      // Sunrise/sunset: warm orange/red (low elevation)
      // Midday: bright white (high elevation)
      let sunriseColor = vec3<f32>(1.0, 0.6, 0.3); // Warm orange
      let middayColor = vec3<f32>(1.0, 0.95, 0.85); // Warm white

      // Blend based on sun elevation
      return mix(sunriseColor, middayColor, elevation * elevation);
    }

    // Calculate sky color from time of day
    // time: time in seconds since midnight (0-86400)
    // Returns RGB color of sky for reflections and ambient lighting
    fn getSkyColor(time: f32) -> vec3<f32> {
      let hour = time / SECONDS_PER_HOUR;
      let sunPhase = (hour - 6.0) * 3.14159 / 12.0;
      let elevation = max(sin(sunPhase), 0.0);

      // Dawn/dusk: darker, more purple/pink
      // Midday: bright blue
      let dawnColor = vec3<f32>(0.4, 0.3, 0.6); // Purple
      let middayColor = vec3<f32>(0.5, 0.7, 0.95); // Light blue

      return mix(dawnColor, middayColor, elevation);
    }
  `,
};
