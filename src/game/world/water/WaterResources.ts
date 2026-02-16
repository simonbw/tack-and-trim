/**
 * Water GPU resource manager.
 *
 * Owns and manages GPU buffers for water data including wave parameters and modifiers.
 * Provides read-only access to buffers for query shaders and render pipelines.
 * Eliminates duplication between the tile pipeline and query system.
 *
 * Also handles:
 * - Collecting water modifiers from "waterModifier" tagged entities each tick
 * - Updating tide height from TimeOfDay
 */

import { BaseEntity } from "../../../core/entity/BaseEntity";
import { on } from "../../../core/entity/handler";

import { profile } from "../../../core/util/Profiler";
import { TimeOfDay } from "../../time/TimeOfDay";
import {
  type GPUWaterModifierData,
  WaterModifier,
  WaterModifierType,
} from "./WaterModifierBase";
import {
  buildWaveDataFromSources,
  DEFAULT_WAVE_CONFIG,
  WaveConfig,
} from "./WaveSource";

/** Maximum number of modifiers that can be processed per frame */
export const MAX_MODIFIERS = 16384;

/** Number of floats per modifier in the GPU buffer */
export const FLOATS_PER_MODIFIER = 8;

// Tide configuration
// Semi-diurnal tide: 2 cycles per day (high at 0h & 12h, low at 6h & 18h)
const DEFAULT_TIDE_RANGE = 4; // ft total range (±2 ft from mean)

/**
 * Manages GPU resources for water data.
 *
 * Resource provider that owns GPU buffers and provides access to them.
 * Stores wave configuration and modifier data for both the tile pipeline
 * and query system.
 */
export class WaterResources extends BaseEntity {
  id = "waterResources";
  tickLayer = "query" as const;

  // GPU device reference (passed in constructor since this.game isn't available yet)
  private device: GPUDevice;

  // GPU buffers
  readonly waveDataBuffer: GPUBuffer;
  readonly modifiersBuffer: GPUBuffer;

  // Wave configuration
  private readonly waveConfig: WaveConfig;

  // CPU-side modifier data array for packing before upload
  private modifierData: Float32Array;

  // Current modifier count (updated each frame)
  private modifierCount: number = 0;

  // Tide height offset (updated each tick)
  private tideHeight: number = 0;

  // Cached modifier data for current frame (for render pipeline access)
  private cachedModifiers: GPUWaterModifierData[] = [];

  constructor(device: GPUDevice, waveConfig?: WaveConfig) {
    super();
    this.device = device;

    // Use provided config or defaults
    this.waveConfig = waveConfig ?? DEFAULT_WAVE_CONFIG;

    // Create wave data storage buffer (static, uploaded once)
    const waveData = buildWaveDataFromSources(this.waveConfig.sources);
    this.waveDataBuffer = device.createBuffer({
      size: waveData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: "Water Wave Data Buffer (Shared)",
      mappedAtCreation: true,
    });
    new Float32Array(this.waveDataBuffer.getMappedRange()).set(waveData);
    this.waveDataBuffer.unmap();

    // Create modifiers storage buffer (dynamic, updated each frame)
    this.modifierData = new Float32Array(MAX_MODIFIERS * FLOATS_PER_MODIFIER);
    this.modifiersBuffer = device.createBuffer({
      size: this.modifierData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: "Water Modifiers Buffer (Shared)",
    });
  }

  /**
   * Collect modifiers and update tide each tick.
   */
  @on("tick")
  @profile
  onTick() {
    // Update tide height from TimeOfDay
    const timeOfDay = this.game.entities.tryGetSingleton(TimeOfDay);
    if (timeOfDay) {
      const hour = timeOfDay.getHour();
      // Semi-diurnal: 2 cycles per day (high at 0h & 12h, low at 6h & 18h)
      const tidePhase = (hour / 12) * Math.PI;
      this.tideHeight = Math.sin(tidePhase) * (DEFAULT_TIDE_RANGE / 2);
    }

    // Collect and cache modifier data for this frame
    this.cachedModifiers = this.collectModifierData();

    // Upload modifiers to GPU buffer
    this.updateModifiers(this.cachedModifiers);
  }

  /**
   * Collect water modifier data from all waterModifier-tagged entities.
   */
  private collectModifierData(): GPUWaterModifierData[] {
    const modifiers: GPUWaterModifierData[] = [];

    for (const entity of this.game.entities.getTagged("waterModifier")) {
      if (entity instanceof WaterModifier) {
        const data = entity.getGPUModifierData();
        if (data !== null) {
          modifiers.push(data);
        }
      }
    }

    return modifiers;
  }

  @on("destroy")
  onDestroy(): void {
    this.waveDataBuffer.destroy();
    this.modifiersBuffer.destroy();
  }

  /**
   * Update the modifiers buffer with water modifier data.
   * Returns the actual number of modifiers uploaded.
   */
  private updateModifiers(modifiers: GPUWaterModifierData[]): number {
    const device = this.device;
    const modifierCount = Math.min(modifiers.length, MAX_MODIFIERS);

    if (modifiers.length > MAX_MODIFIERS) {
      console.warn(
        `Water modifiers (${modifiers.length}) exceeds MAX_MODIFIERS (${MAX_MODIFIERS}), truncating`,
      );
    }

    for (let i = 0; i < modifierCount; i++) {
      const mod = modifiers[i];
      const base = i * FLOATS_PER_MODIFIER;

      // Header: type + bounds (AABB)
      this.modifierData[base + 0] = mod.type;
      this.modifierData[base + 1] = mod.bounds.lowerBound.x;
      this.modifierData[base + 2] = mod.bounds.lowerBound.y;
      this.modifierData[base + 3] = mod.bounds.upperBound.x;
      this.modifierData[base + 4] = mod.bounds.upperBound.y;

      // Pack type-specific data into [5-7]
      switch (mod.data.type) {
        case WaterModifierType.Wake:
          this.modifierData[base + 5] = mod.data.intensity;
          this.modifierData[base + 6] = mod.data.velocityX;
          this.modifierData[base + 7] = mod.data.velocityY;
          break;
        case WaterModifierType.Ripple:
          this.modifierData[base + 5] = mod.data.radius;
          this.modifierData[base + 6] = mod.data.intensity;
          this.modifierData[base + 7] = mod.data.phase;
          break;
        case WaterModifierType.Current:
          this.modifierData[base + 5] = mod.data.velocityX;
          this.modifierData[base + 6] = mod.data.velocityY;
          this.modifierData[base + 7] = mod.data.fadeDistance;
          break;
        case WaterModifierType.Obstacle:
          this.modifierData[base + 5] = mod.data.dampingFactor;
          this.modifierData[base + 6] = mod.data.padding1;
          this.modifierData[base + 7] = mod.data.padding2;
          break;
      }
    }

    // Only upload the portion we need
    if (modifierCount > 0) {
      const uploadSize = modifierCount * FLOATS_PER_MODIFIER * 4;
      device.queue.writeBuffer(
        this.modifiersBuffer,
        0,
        this.modifierData.buffer,
        0,
        uploadSize,
      );
    }

    this.modifierCount = modifierCount;
    return modifierCount;
  }

  /**
   * Set the tide height offset.
   */
  setTideHeight(height: number): void {
    this.tideHeight = height;
  }

  /**
   * Get the current tide height offset.
   */
  getTideHeight(): number {
    return this.tideHeight;
  }

  /**
   * Get the number of active modifiers.
   */
  getModifierCount(): number {
    return this.modifierCount;
  }

  /**
   * Get the number of wave sources.
   */
  getNumWaves(): number {
    return this.waveConfig.sources.length;
  }

  /**
   * Get the wave configuration.
   */
  getWaveConfig(): WaveConfig {
    return this.waveConfig;
  }

  /**
   * Get the cached modifier data for the current frame.
   * Used by render pipelines that need access to modifier data.
   */
  getCachedModifiers(): GPUWaterModifierData[] {
    return this.cachedModifiers;
  }
}
