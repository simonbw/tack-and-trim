import { createNoise3D, NoiseFunction3D } from "simplex-noise";
import BaseEntity from "../../core/entity/BaseEntity";
import { profiler } from "../../core/util/Profiler";
import { SparseSpatialHash } from "../../core/util/SparseSpatialHash";
import { V, V2d } from "../../core/Vector";
import { WaterModifier } from "./WaterModifier";

// Units: ft, ft/s for velocities
// Current variation configuration
// Water currents are much slower and vary more gradually than wind
const CURRENT_SPATIAL_SCALE = 0.002; // Currents vary slowly across space
const CURRENT_TIME_SCALE = 0.05; // Currents change slowly over time
const CURRENT_SPEED_VARIATION = 0.4; // ±40% speed variation
const CURRENT_ANGLE_VARIATION = 0.5; // ±~30° direction variation

// Gerstner wave configuration
// Each wave: [amplitude, wavelength, direction, phaseOffset, speedMult, sourceDist, sourceOffset]
// - amplitude (ft): wave height
// - wavelength (ft): distance between peaks
// - direction (radians): wave travel direction
// - phaseOffset (radians): initial phase (decoheres waves so they don't peak together)
// - speedMult: multiplier on physical wave speed (creates interference drift)
// - sourceDist (ft): distance to wave source (Infinity = planar wave, finite = curved)
// - sourceOffset ([x,y] ft): offset of source from the direction axis (adds variety)
const WAVE_COMPONENTS: [
  number,
  number,
  number,
  number,
  number,
  number,
  [number, number],
][] = [
  // Large ocean swells - planar (traveled thousands of miles)
  [0.25, 400, 0.1, 0.0, 1.0, Infinity, [0, 0]],
  [0.18, 250, 1.7, 3.2, 0.98, Infinity, [0, 0]],
  [0.12, 150, -0.5, 1.5, 1.02, Infinity, [0, 0]],
  // Medium swells - very slight curvature
  [0.15, 80, 0.8, 4.8, 0.97, 8000, [500, -300]],
  [0.12, 55, -1.2, 2.1, 1.03, 6000, [-400, 600]],
  // Wind waves - noticeable curvature, from nearby weather
  [0.18, 35, 1.5, 5.5, 0.99, 2000, [300, 200]],
  [0.12, 22, -0.3, 0.9, 1.01, 1500, [-500, -400]],
  [0.08, 14, 2.2, 3.7, 0.96, 1200, [200, -300]],
  // Chop - more curvature, local disturbances
  [0.04, 8, -1.5, 1.3, 1.05, 600, [-150, 100]],
  [0.025, 5, 0.5, 4.2, 0.94, 400, [100, -80]],
  // Fine ripples - high curvature, very local
  [0.012, 3, 1.8, 2.6, 1.08, 200, [-60, 40]],
  [0.006, 2, -0.8, 5.9, 0.92, 150, [30, -50]],
];

// Gerstner wave steepness (0 = sine waves, higher = sharper peaks)
// Max safe value is 1/(k*A*numWaves) to prevent self-intersection
const GERSTNER_STEEPNESS = 0.7; // 0.7 gives nice sharp peaks without breaking

// Amplitude modulation configuration
const WAVE_AMP_MOD_SPATIAL_SCALE = 0.005; // Slower variation across space
const WAVE_AMP_MOD_TIME_SCALE = 0.015; // Very slow temporal variation
const WAVE_AMP_MOD_STRENGTH = 0.5; // ±50% amplitude variation

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

    // Start with wave height
    let surfaceHeight = this.getWaveHeightAtPoint(point[0], point[1]);

    // Query spatial hash for nearby water modifiers
    for (const modifier of this.spatialHash.queryPoint(point)) {
      const contrib = modifier.getWaterContribution(point);
      velocity.x += contrib.velocityX;
      velocity.y += contrib.velocityY;
      surfaceHeight += contrib.height;
    }

    return {
      velocity,
      surfaceHeight,
    };
  }

  // Preallocated scratch point to avoid allocations during grid updates
  private readonly scratchPoint: V2d = V(0, 0);

  /**
   * Update every Nth pixel in the water data texture, starting at a given offset.
   * Writes directly to the Uint8Array to avoid intermediate allocations.
   *
   * @param dataArray - The texture's Uint8Array to write to
   * @param offset - Which pixel to start at (0 to stride-1)
   * @param stride - Update every Nth pixel
   * @param left - World X coordinate of left edge
   * @param top - World Y coordinate of top edge
   * @param cellWidth - Width of each cell in world units
   * @param cellHeight - Height of each cell in world units
   * @param gridSize - Number of cells per row/column
   * @param heightScale - Scale factor for height packing
   * @param heightOffset - Offset for height packing (neutral height value, e.g. 127)
   * @param velocityScale - Scale factor for velocity packing
   * @param velocityOffset - Offset for velocity packing (to handle negative values)
   */
  writeStateToTexture(
    dataArray: Uint8Array,
    offset: number,
    stride: number,
    left: number,
    top: number,
    cellWidth: number,
    cellHeight: number,
    gridSize: number,
    heightScale: number,
    heightOffset: number,
    velocityScale: number,
    velocityOffset: number,
  ): void {
    const point = this.scratchPoint;
    const numCells = gridSize * gridSize;

    for (let i = offset; i < numCells; i += stride) {
      const x = i % gridSize;
      const y = Math.floor(i / gridSize);

      // Compute world position (reuse scratch point)
      point.x = left + (x + 0.5) * cellWidth;
      point.y = top + (y + 0.5) * cellHeight;

      // Get base velocity from noise
      const baseVel = this.getCurrentVelocityAtPoint(point);
      let velX = baseVel.x;
      let velY = baseVel.y;
      let height = this.getWaveHeightAtPoint(point.x, point.y);

      // Query and apply modifiers directly (no intermediate arrays)
      for (const modifier of this.spatialHash.queryPoint(point)) {
        const contrib = modifier.getWaterContribution(point);
        velX += contrib.velocityX;
        velY += contrib.velocityY;
        height += contrib.height;
      }

      // Pack directly into texture array
      // Height is centered at heightOffset (127), can go up or down
      const idx = i * 4;
      dataArray[idx + 0] = Math.min(
        255,
        Math.max(0, height * heightScale + heightOffset),
      );
      dataArray[idx + 1] = Math.min(
        255,
        Math.max(0, velX * velocityScale + velocityOffset),
      );
      dataArray[idx + 2] = Math.min(
        255,
        Math.max(0, velY * velocityScale + velocityOffset),
      );
      dataArray[idx + 3] = 255; // Alpha channel unused
    }
  }

  /**
   * Calculate wave height using Gerstner waves with decoherence.
   * - Phase offsets prevent all waves from peaking together
   * - Speed multipliers create drifting interference patterns
   * - Position-dependent phase noise adds local variation
   */
  private getWaveHeightAtPoint(x: number, y: number): number {
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
      sourceOffset,
    ] of WAVE_COMPONENTS) {
      const baseDx = Math.cos(direction);
      const baseDy = Math.sin(direction);
      const k = (2 * Math.PI) / wavelength;
      const omega = Math.sqrt(9.8 * 3.28084 * k) * speedMult;

      let dx: number, dy: number, phase: number;

      if (!isFinite(sourceDist)) {
        // Planar wave - original calculation
        dx = baseDx;
        dy = baseDy;
        const projected = x * dx + y * dy;
        phase = k * projected - omega * t + phaseOffset;
      } else {
        // Point source wave - curved wavefronts
        // Source is behind the wave direction, with optional offset
        const sourceX = -baseDx * sourceDist + sourceOffset[0];
        const sourceY = -baseDy * sourceDist + sourceOffset[1];

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

    // Second pass: compute height at displaced position
    const sampleX = x - dispX;
    const sampleY = y - dispY;
    let height = 0;

    for (const [
      amplitude,
      wavelength,
      direction,
      phaseOffset,
      speedMult,
      sourceDist,
      sourceOffset,
    ] of WAVE_COMPONENTS) {
      const baseDx = Math.cos(direction);
      const baseDy = Math.sin(direction);
      const k = (2 * Math.PI) / wavelength;
      const omega = Math.sqrt(9.8 * 3.28084 * k) * speedMult;

      let phase: number;

      if (!isFinite(sourceDist)) {
        // Planar wave
        const projected = sampleX * baseDx + sampleY * baseDy;
        phase = k * projected - omega * t + phaseOffset;
      } else {
        // Point source wave
        const sourceX = -baseDx * sourceDist + sourceOffset[0];
        const sourceY = -baseDy * sourceDist + sourceOffset[1];

        const toPointX = sampleX - sourceX;
        const toPointY = sampleY - sourceY;
        const distFromSource = Math.sqrt(
          toPointX * toPointX + toPointY * toPointY,
        );

        phase = k * distFromSource - omega * t + phaseOffset;
      }

      height += amplitude * ampMod * Math.sin(phase);
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

    return height;
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
}
