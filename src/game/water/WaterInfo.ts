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

// Wave configuration - sum of sines approach
// Each wave: [amplitude (ft), wavelength (ft), speed (ft/s), direction (radians)]
// Light conditions in protected water (small chop)
const WAVE_COMPONENTS: [number, number, number, number][] = [
  [0.3, 40, 3, 0.2], // Primary wave - 4" amplitude, 40ft wavelength
  [0.15, 25, 2, -0.4], // Secondary wave
  [0.08, 15, 1.5, 0.8], // Tertiary wave
  [0.04, 8, 1, -1.2], // Detail wave - small ripples
];

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

  // Spatial hash for efficient water modifier queries
  private spatialHash = new SparseSpatialHash<WaterModifier>(
    (m) => m.getWaterModifierAABB()
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
    velocityOffset: number
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
        Math.max(0, height * heightScale + heightOffset)
      );
      dataArray[idx + 1] = Math.min(
        255,
        Math.max(0, velX * velocityScale + velocityOffset)
      );
      dataArray[idx + 2] = Math.min(
        255,
        Math.max(0, velY * velocityScale + velocityOffset)
      );
      dataArray[idx + 3] = 255; // Alpha channel unused
    }
  }

  /**
   * Calculate wave height at a given world position using sum of sines.
   */
  private getWaveHeightAtPoint(x: number, y: number): number {
    const t = this.game?.elapsedUnpausedTime ?? 0;
    let height = 0;

    for (const [amplitude, wavelength, speed, direction] of WAVE_COMPONENTS) {
      // Project position onto wave direction
      const dx = Math.cos(direction);
      const dy = Math.sin(direction);
      const projected = x * dx + y * dy;

      // Calculate phase
      const k = (2 * Math.PI) / wavelength;
      const phase = k * projected - speed * t;

      height += amplitude * Math.sin(phase);
    }

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
