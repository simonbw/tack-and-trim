/**
 * Wind shader modules for velocity field computation.
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";
import { fn_simplex3D } from "./noise.wgsl";

/**
 * Wind velocity calculation function.
 * Computes wind velocity with noise-based variation and terrain influence.
 *
 * Requires parameters:
 * - baseWind: vec2<f32> - base wind velocity
 * - influenceSpeedFactor: f32 - terrain speed multiplier
 * - influenceDirectionOffset: f32 - terrain direction offset (radians)
 * - influenceTurbulence: f32 - terrain-induced turbulence factor
 */
export const fn_calculateWindVelocity: ShaderModule = {
  code: /*wgsl*/ `
    // Calculate wind velocity at a world position with noise variation
    // worldPos: position in world coordinates
    // time: game time for noise animation
    // baseWind: base wind velocity (before modulation)
    // influenceSpeedFactor: terrain-induced speed multiplier (1.0 = no change)
    // influenceDirectionOffset: terrain-induced direction change (radians)
    // influenceTurbulence: terrain-induced turbulence boost (0-1+)
    // noiseSpatialScale: spatial frequency of noise
    // noiseTimeScale: temporal frequency of noise
    // speedVariation: amplitude of speed variation (0-1)
    // angleVariation: amplitude of angle variation (radians)
    fn calculateWindVelocity(
      worldPos: vec2<f32>,
      time: f32,
      baseWind: vec2<f32>,
      influenceSpeedFactor: f32,
      influenceDirectionOffset: f32,
      influenceTurbulence: f32,
      noiseSpatialScale: f32,
      noiseTimeScale: f32,
      speedVariation: f32,
      angleVariation: f32,
      flowCyclePeriod: f32,
      slowTimeScale: f32
    ) -> vec2<f32> {
      // Compute local flow velocity from terrain-modified wind
      let localFlow = baseWind * influenceSpeedFactor;
      let cosDir = cos(influenceDirectionOffset);
      let sinDir = sin(influenceDirectionOffset);
      let flow = vec2<f32>(
        localFlow.x * cosDir - localFlow.y * sinDir,
        localFlow.x * sinDir + localFlow.y * cosDir
      );

      // Dual-layer flow-map: two time phases offset by half a cycle
      let t0 = fract(time / flowCyclePeriod);
      let t1 = fract(time / flowCyclePeriod + 0.5);
      let blend = abs(2.0 * t0 - 1.0);

      // Slow time for organic z-axis evolution
      let slowTime = time * slowTimeScale;

      // Flow-advected UVs for speed noise
      let uv0_speed = (worldPos - flow * t0 * flowCyclePeriod) * noiseSpatialScale;
      let uv1_speed = (worldPos - flow * t1 * flowCyclePeriod) * noiseSpatialScale;
      let speedNoise = mix(
        simplex3D(vec3<f32>(uv0_speed, slowTime)),
        simplex3D(vec3<f32>(uv1_speed, slowTime)),
        blend
      );

      // Flow-advected UVs for angle noise (offset for independent variation)
      let uv0_angle = uv0_speed + vec2<f32>(1000.0, 1000.0);
      let uv1_angle = uv1_speed + vec2<f32>(1000.0, 1000.0);
      let angleNoise = mix(
        simplex3D(vec3<f32>(uv0_angle, slowTime)),
        simplex3D(vec3<f32>(uv1_angle, slowTime)),
        blend
      );

      // Apply terrain influence to speed variation (turbulence boosts noise)
      let turbulenceBoost = 1.0 + influenceTurbulence * 0.5;
      var speedScale = 1.0 + speedNoise * speedVariation * turbulenceBoost;
      speedScale *= influenceSpeedFactor; // Apply terrain blocking/acceleration

      // Apply influence direction offset + noise angle
      let totalAngleOffset = angleNoise * angleVariation + influenceDirectionOffset;

      // Apply speed scale to base wind
      let scaledX = baseWind.x * speedScale;
      let scaledY = baseWind.y * speedScale;

      // Rotate by total angle offset
      let cosAngle = cos(totalAngleOffset);
      let sinAngle = sin(totalAngleOffset);
      let velocityX = scaledX * cosAngle - scaledY * sinAngle;
      let velocityY = scaledX * sinAngle + scaledY * cosAngle;

      return vec2<f32>(velocityX, velocityY);
    }
  `,
  dependencies: [fn_simplex3D],
};

/**
 * Wind query result structure.
 */
export const struct_WindResult: ShaderModule = {
  code: /*wgsl*/ `
    // Wind query result structure
    struct WindResult {
      velocity: vec2<f32>,
      speed: f32,
      direction: f32,
    }
  `,
  dependencies: [],
};

/**
 * Wind query computation function.
 * Provides high-level wind query function that returns velocity, speed, and direction.
 */
export const fn_computeWindAtPoint: ShaderModule = {
  code: /*wgsl*/ `
    // Compute wind state at a world position
    // Returns velocity, speed, and direction
    fn computeWindAtPoint(
      worldPos: vec2<f32>,
      time: f32,
      baseWind: vec2<f32>,
      influenceSpeedFactor: f32,
      influenceDirectionOffset: f32,
      influenceTurbulence: f32,
      noiseSpatialScale: f32,
      noiseTimeScale: f32,
      speedVariation: f32,
      angleVariation: f32,
      flowCyclePeriod: f32,
      slowTimeScale: f32
    ) -> WindResult {
      // Calculate velocity using wind module
      let velocity = calculateWindVelocity(
        worldPos,
        time,
        baseWind,
        influenceSpeedFactor,
        influenceDirectionOffset,
        influenceTurbulence,
        noiseSpatialScale,
        noiseTimeScale,
        speedVariation,
        angleVariation,
        flowCyclePeriod,
        slowTimeScale
      );

      // Compute speed and direction from velocity
      let speed = length(velocity);
      let direction = atan2(velocity.y, velocity.x);

      var result: WindResult;
      result.velocity = velocity;
      result.speed = speed;
      result.direction = direction;
      return result;
    }
  `,
  dependencies: [struct_WindResult, fn_calculateWindVelocity],
};
