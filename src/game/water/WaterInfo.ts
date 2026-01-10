import { createNoise3D, NoiseFunction3D } from "simplex-noise";
import BaseEntity from "../../core/entity/BaseEntity";
import { profiler } from "../../core/util/Profiler";
import { SparseSpatialHash } from "../../core/util/SparseSpatialHash";
import { V, V2d } from "../../core/Vector";
import {
  GERSTNER_STEEPNESS,
  GRAVITY_FT_PER_S2,
  WAVE_AMP_MOD_SPATIAL_SCALE,
  WAVE_AMP_MOD_STRENGTH,
  WAVE_AMP_MOD_TIME_SCALE,
  WAVE_COMPONENTS,
} from "./WaterConstants";
import { WaterModifier } from "./WaterModifier";

// Units: ft, ft/s for velocities
// Current variation configuration
// Water currents are much slower and vary more gradually than wind
const CURRENT_SPATIAL_SCALE = 0.002; // Currents vary slowly across space
const CURRENT_TIME_SCALE = 0.05; // Currents change slowly over time
const CURRENT_SPEED_VARIATION = 0.4; // ±40% speed variation
const CURRENT_ANGLE_VARIATION = 0.5; // ±~30° direction variation

/**
 * Simple hash function for white noise - returns value in range [0, 1]
 * Uses the fractional part of a large sine product
 */
function hash2D(x: number, y: number): number {
  // Different large primes for x and y to avoid correlation
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

/**
 * Water state at a given point in the world.
 */
export interface WaterState {
  /** Combined water velocity (currents + waves + wakes) */
  velocity: V2d;
  /** Wave surface displacement at this point */
  surfaceHeight: number;
  /** Rate of height change (dh/dt) in ft/s - positive when water is rising */
  surfaceHeightRate: number;
}

/**
 * Water physics data provider.
 * Provides a query interface for water state at any world position,
 * used by underwater physics components (keel, rudder, hull).
 */
export class WaterInfo extends BaseEntity {
  id = "waterInfo";

  // Current simulation
  private baseCurrentVelocity: V2d = V(1.5, 0.5); // ~1.6 ft/s (~1 kt) tidal current
  private speedNoise: NoiseFunction3D = createNoise3D();
  private angleNoise: NoiseFunction3D = createNoise3D();

  // Wave amplitude modulation - simulates wave groups/packets (physically real)
  private waveAmpModNoise: NoiseFunction3D = createNoise3D();

  // Surface turbulence noise - small chaotic variations that break up the grid
  private surfaceNoise: NoiseFunction3D = createNoise3D();

  // Spatial hash for efficient water modifier queries
  private spatialHash = new SparseSpatialHash<WaterModifier>((m) =>
    m.getWaterModifierAABB(),
  );

  onTick() {
    profiler.start("water-info-tick");
    // Rebuild spatial hash from all water modifiers
    this.spatialHash.clear();
    const modifiers = this.game!.entities.getTagged("waterModifier");
    for (const modifier of modifiers) {
      this.spatialHash.add(modifier as unknown as WaterModifier);
    }
    profiler.end("water-info-tick");
  }

  /**
   * Get the water state at a given world position.
   * Used by underwater physics components to determine water velocity.
   */
  getStateAtPoint(point: V2d): WaterState {
    // Start with current velocity
    const velocity = this.getCurrentVelocityAtPoint(point);

    // Get wave height and dh/dt
    const waveData = this.getWaveDataAtPoint(point[0], point[1]);
    let surfaceHeight = waveData.height;
    let surfaceHeightRate = waveData.dhdt;

    // Query spatial hash for nearby water modifiers
    for (const modifier of this.spatialHash.queryPoint(point)) {
      const contrib = modifier.getWaterContribution(point);
      velocity.x += contrib.velocityX;
      velocity.y += contrib.velocityY;
      surfaceHeight += contrib.height;
      surfaceHeightRate += contrib.heightRate ?? 0;
    }

    return {
      velocity,
      surfaceHeight,
      surfaceHeightRate,
    };
  }

  /**
   * Calculate wave height and dh/dt using Gerstner waves with decoherence.
   * - Phase offsets prevent all waves from peaking together
   * - Speed multipliers create drifting interference patterns
   * - Position-dependent phase noise adds local variation
   */
  private getWaveDataAtPoint(
    x: number,
    y: number,
  ): { height: number; dhdt: number } {
    const t = this.game?.elapsedUnpausedTime ?? 0;

    // Sample amplitude modulation noise once per point (slow-changing)
    const ampModTime = t * WAVE_AMP_MOD_TIME_SCALE;
    const ampMod =
      1 +
      this.waveAmpModNoise(
        x * WAVE_AMP_MOD_SPATIAL_SCALE,
        y * WAVE_AMP_MOD_SPATIAL_SCALE,
        ampModTime,
      ) *
        WAVE_AMP_MOD_STRENGTH;

    // First pass: compute Gerstner horizontal displacement
    let dispX = 0;
    let dispY = 0;
    const numWaves = WAVE_COMPONENTS.length;

    for (const [
      amplitude,
      wavelength,
      direction,
      phaseOffset,
      speedMult,
      sourceDist,
      sourceOffsetX,
      sourceOffsetY,
    ] of WAVE_COMPONENTS) {
      const baseDx = Math.cos(direction);
      const baseDy = Math.sin(direction);
      const k = (2 * Math.PI) / wavelength;
      const omega = Math.sqrt(GRAVITY_FT_PER_S2 * k) * speedMult;

      let dx: number, dy: number, phase: number;

      // sourceDist > 1e9 means planar wave (using 1e10 instead of Infinity for GLSL compat)
      if (sourceDist > 1e9) {
        // Planar wave - original calculation
        dx = baseDx;
        dy = baseDy;
        const projected = x * dx + y * dy;
        phase = k * projected - omega * t + phaseOffset;
      } else {
        // Point source wave - curved wavefronts
        // Source is behind the wave direction, with optional offset
        const sourceX = -baseDx * sourceDist + sourceOffsetX;
        const sourceY = -baseDy * sourceDist + sourceOffsetY;

        const toPointX = x - sourceX;
        const toPointY = y - sourceY;
        const distFromSource = Math.sqrt(
          toPointX * toPointX + toPointY * toPointY,
        );

        // Local wave direction is radial from source
        dx = toPointX / distFromSource;
        dy = toPointY / distFromSource;
        phase = k * distFromSource - omega * t + phaseOffset;
      }

      // Gerstner horizontal displacement
      const Q = GERSTNER_STEEPNESS / (k * amplitude * numWaves);
      const cosPhase = Math.cos(phase);
      dispX += Q * amplitude * dx * cosPhase;
      dispY += Q * amplitude * dy * cosPhase;
    }

    // Second pass: compute height and dh/dt at displaced position
    const sampleX = x - dispX;
    const sampleY = y - dispY;
    let height = 0;
    let dhdt = 0;

    for (const [
      amplitude,
      wavelength,
      direction,
      phaseOffset,
      speedMult,
      sourceDist,
      sourceOffsetX,
      sourceOffsetY,
    ] of WAVE_COMPONENTS) {
      const baseDx = Math.cos(direction);
      const baseDy = Math.sin(direction);
      const k = (2 * Math.PI) / wavelength;
      const omega = Math.sqrt(GRAVITY_FT_PER_S2 * k) * speedMult;

      let phase: number;

      if (sourceDist > 1e9) {
        // Planar wave
        const projected = sampleX * baseDx + sampleY * baseDy;
        phase = k * projected - omega * t + phaseOffset;
      } else {
        // Point source wave
        const sourceX = -baseDx * sourceDist + sourceOffsetX;
        const sourceY = -baseDy * sourceDist + sourceOffsetY;

        const toPointX = sampleX - sourceX;
        const toPointY = sampleY - sourceY;
        const distFromSource = Math.sqrt(
          toPointX * toPointX + toPointY * toPointY,
        );

        phase = k * distFromSource - omega * t + phaseOffset;
      }

      const sinPhase = Math.sin(phase);
      const cosPhase = Math.cos(phase);

      height += amplitude * ampMod * sinPhase;

      // dh/dt = d/dt[A * ampMod * sin(k*d - omega*t + phi)]
      //       = A * ampMod * cos(phase) * (-omega)
      //       = -A * ampMod * omega * cos(phase)
      dhdt += -amplitude * ampMod * omega * cosPhase;
    }

    // Add surface turbulence - small non-periodic noise that breaks up the grid
    // This represents chaotic micro-variations not captured by the wave model
    // Mix of smooth noise (for organic feel) and white noise (for randomness)
    const smoothTurbulence =
      this.surfaceNoise(x * 0.15, y * 0.15, t * 0.5) * 0.03 +
      this.surfaceNoise(x * 0.4, y * 0.4, t * 0.8) * 0.01;

    // White noise - changes per pixel, animated slowly with time
    // Use floor(t) to change the noise pattern roughly once per second
    const timeCell = Math.floor(t * 0.5);
    const whiteTurbulence = (hash2D(x * 0.5 + timeCell, y * 0.5) - 0.5) * 0.02;

    height += smoothTurbulence + whiteTurbulence;
    // Note: turbulence contribution to dhdt is negligible and non-physical, so we skip it

    return { height, dhdt };
  }

  /**
   * Get the current velocity at a given world position.
   * Uses simplex noise for natural spatial and temporal variation.
   */
  private getCurrentVelocityAtPoint([x, y]: V2d): V2d {
    const t = (this.game?.elapsedUnpausedTime ?? 0) * CURRENT_TIME_SCALE;

    const sx = x * CURRENT_SPATIAL_SCALE;
    const sy = y * CURRENT_SPATIAL_SCALE;

    // Sample noise for speed and angle variation
    const speedScale = 1 + this.speedNoise(sx, sy, t) * CURRENT_SPEED_VARIATION;
    const angleVariance = this.angleNoise(sx, sy, t) * CURRENT_ANGLE_VARIATION;

    return this.baseCurrentVelocity.mul(speedScale).irotate(angleVariance);
  }

  /**
   * Set the base current velocity.
   */
  setCurrentVelocity(velocity: V2d): void {
    this.baseCurrentVelocity.set(velocity);
  }

  /**
   * Get the current speed (magnitude of base velocity).
   */
  getCurrentSpeed(): number {
    return this.baseCurrentVelocity.magnitude;
  }

  /**
   * Get the current direction angle.
   */
  getCurrentAngle(): number {
    return this.baseCurrentVelocity.angle;
  }

  /**
   * Query water modifiers at a given point.
   * Used by ModifierDataTexture to build the modifier texture.
   */
  queryModifiersAtPoint(point: V2d): Iterable<WaterModifier> {
    return this.spatialHash.queryPoint(point);
  }

  /**
   * Get all water modifiers.
   * Used by ModifierDataTexture to iterate through modifiers efficiently.
   */
  getAllModifiers(): Iterable<WaterModifier> {
    const modifiers = this.game!.entities.getTagged("waterModifier");
    // Debug: uncomment to verify modifiers are found
    // console.log("[WaterInfo] getAllModifiers:", modifiers.length);
    return modifiers as unknown as WaterModifier[];
  }
}
