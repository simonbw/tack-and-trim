/**
 * Pure CPU wind computation.
 *
 * Provides fallback for out-of-viewport queries when GPU tiles
 * are not available. The math here matches the GPU shader exactly.
 */

import { NoiseFunction3D } from "simplex-noise";
import { V2d } from "../../../../core/Vector";
import {
  WIND_ANGLE_VARIATION,
  WIND_NOISE_SPATIAL_SCALE,
  WIND_NOISE_TIME_SCALE,
  WIND_SPEED_VARIATION,
} from "../WindConstants";

/**
 * Wind velocity at a specific point.
 */
export interface WindVelocityData {
  /** Wind velocity X component in ft/s */
  velocityX: number;
  /** Wind velocity Y component in ft/s */
  velocityY: number;
}

/**
 * Parameters for CPU wind computation.
 */
export interface WindComputeParams {
  /** Current game time in seconds */
  time: number;
  /** Base wind velocity (before noise variation) */
  baseVelocity: V2d;
  /** Noise function for speed variation */
  speedNoise: NoiseFunction3D;
  /** Noise function for angle variation */
  angleNoise: NoiseFunction3D;
  /** Terrain influence speed multiplier (1.0 = no change) */
  influenceSpeedFactor: number;
  /** Terrain influence direction offset in radians */
  influenceDirectionOffset: number;
  /** Terrain influence turbulence (0 = no extra turbulence) */
  influenceTurbulence: number;
}

/**
 * Compute base wind velocity at a world position using simplex noise.
 *
 * This implements the same algorithm as WindInfo.getBaseVelocityAtPoint(),
 * matching the GPU compute shader exactly.
 *
 * @param x World X coordinate in ft
 * @param y World Y coordinate in ft
 * @param params Computation parameters (time, base velocity, noise functions)
 * @returns Wind velocity components
 */
export function computeBaseWindAtPoint(
  x: number,
  y: number,
  params: WindComputeParams,
): WindVelocityData {
  const {
    time,
    baseVelocity,
    speedNoise,
    angleNoise,
    influenceSpeedFactor,
    influenceDirectionOffset,
    influenceTurbulence,
  } = params;

  const t = time * WIND_NOISE_TIME_SCALE;
  const sx = x * WIND_NOISE_SPATIAL_SCALE;
  const sy = y * WIND_NOISE_SPATIAL_SCALE;

  // Sample noise for speed and angle variation
  // Apply terrain influence to speed variation (turbulence boosts noise)
  const turbulenceBoost = 1 + influenceTurbulence * 0.5;
  const speedScale =
    (1 + speedNoise(sx, sy, t) * WIND_SPEED_VARIATION * turbulenceBoost) *
    influenceSpeedFactor;

  // Apply influence direction offset + noise angle
  const totalAngleOffset =
    angleNoise(sx, sy, t) * WIND_ANGLE_VARIATION + influenceDirectionOffset;

  // Apply speed scale
  const scaledX = baseVelocity[0] * speedScale;
  const scaledY = baseVelocity[1] * speedScale;

  // Rotate by total angle offset
  const cos = Math.cos(totalAngleOffset);
  const sin = Math.sin(totalAngleOffset);
  const velocityX = scaledX * cos - scaledY * sin;
  const velocityY = scaledX * sin + scaledY * cos;

  return { velocityX, velocityY };
}
