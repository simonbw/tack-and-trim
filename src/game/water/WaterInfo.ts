import { createNoise3D, NoiseFunction3D } from "simplex-noise";
import BaseEntity from "../../core/entity/BaseEntity";
import { profiler } from "../../core/util/Profiler";
import { SparseSpatialHash } from "../../core/util/SparseSpatialHash";
import { V, V2d } from "../../core/Vector";
import {
  computeWaveDataAtPoint,
  WaterComputeParams,
} from "./cpu/WaterComputeCPU";
import { WaterModifier } from "./WaterModifier";
import type { WaterReadbackBuffer } from "./webgpu/WaterReadbackBuffer";

// Units: ft, ft/s for velocities
// Current variation configuration
// Water currents are much slower and vary more gradually than wind
const CURRENT_SPATIAL_SCALE = 0.002; // Currents vary slowly across space
const CURRENT_TIME_SCALE = 0.05; // Currents change slowly over time
const CURRENT_SPEED_VARIATION = 0.4; // ±40% speed variation
const CURRENT_ANGLE_VARIATION = 0.5; // ±~30° direction variation

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
 *
 * Supports hybrid GPU/CPU wave computation:
 * - GPU readback provides wave data for in-viewport queries (faster)
 * - CPU fallback for out-of-viewport queries (consistent)
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

  // GPU readback buffer for physics queries (set by WaterRendererGPU)
  private readbackBuffer: WaterReadbackBuffer | null = null;

  // CPU compute params (cached for fallback computations)
  private get cpuParams(): WaterComputeParams {
    return {
      time: this.readbackBuffer?.getComputedTime() ?? this.game?.elapsedUnpausedTime ?? 0,
      waveAmpModNoise: this.waveAmpModNoise,
      surfaceNoise: this.surfaceNoise,
    };
  }

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
   * Set the GPU readback buffer for physics queries.
   * Called by WaterRendererGPU after initialization.
   */
  setReadbackBuffer(buffer: WaterReadbackBuffer): void {
    this.readbackBuffer = buffer;
  }

  /**
   * Get readback statistics for debugging/tuning.
   * Returns null if no readback buffer is set.
   */
  getReadbackStats(): { gpuHits: number; cpuFallbacks: number } | null {
    return this.readbackBuffer?.stats ?? null;
  }

  /**
   * Get the water state at a given world position.
   * Uses GPU readback when available, falls back to CPU computation.
   * Used by underwater physics components to determine water velocity.
   */
  getStateAtPoint(point: V2d): WaterState {
    // Start with current velocity
    const velocity = this.getCurrentVelocityAtPoint(point);

    // Try GPU readback first, fall back to CPU
    let waveData = this.readbackBuffer?.sampleAt(point[0], point[1]);

    if (!waveData) {
      // CPU fallback - use the same time as GPU computation for consistency
      waveData = computeWaveDataAtPoint(point[0], point[1], this.cpuParams);
    }

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
