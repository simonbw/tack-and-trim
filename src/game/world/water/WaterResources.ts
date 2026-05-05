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
import { GameEventMap } from "../../../core/entity/Entity";
import { on } from "../../../core/entity/handler";

import { profile } from "../../../core/util/Profiler";
import { TimeOfDay } from "../../time/TimeOfDay";
import type { Viewport } from "../../wave-physics/WavePhysicsResources";
import {
  FLOATS_PER_MODIFIER,
  MAX_MODIFIERS,
} from "../query/query-worker-protocol";
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

/**
 * Re-exports of the shared protocol constants. Single source of truth
 * lives in `query-worker-protocol.ts`. Buffer layout per modifier
 * (`FLOATS_PER_MODIFIER` floats):
 *   [0]  type          u32 modifier type discriminator (WaterModifierType enum)
 *   [1]  minX          AABB lower bound X (ft) — used for bounds culling
 *   [2]  minY          AABB lower bound Y (ft)
 *   [3]  maxX          AABB upper bound X (ft)
 *   [4]  maxY          AABB upper bound Y (ft)
 *   [5..13]            type-specific data (see below)
 *
 * Wake (expanding ring pulse):
 *   [5]  posX          source position X (ft)
 *   [6]  posY          source position Y (ft)
 *   [7]  ringRadius    distance from center to ring peak (ft)
 *   [8]  ringWidth     Gaussian width of ring pulse (ft)
 *   [9]  amplitude     pre-computed height at ring (ft)
 *   [10] omega         angular frequency of wake wave (rad/s)
 *
 * Foam (static turbulent blob):
 *   [5]  posX          center X (ft)
 *   [6]  posY          center Y (ft)
 *   [7]  radius        Gaussian width of the blob (ft)
 *   [8]  intensity     pre-computed foam intensity (0-1)
 *
 * Unused slots per-type are zero-padded.
 */
export { FLOATS_PER_MODIFIER, MAX_MODIFIERS };

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

  // GPU buffers
  waveDataBuffer!: GPUBuffer;
  modifiersBuffer!: GPUBuffer;

  // Wave configuration
  private waveConfig: WaveConfig;

  /**
   * CPU-side modifier data array for packing before upload. Backed by a
   * SharedArrayBuffer so the CPU query worker can read live updates each
   * frame without a copy.
   */
  private modifierData!: Float32Array;
  private modifierDataSab!: SharedArrayBuffer;

  /**
   * Wave source parameters as a Float32Array (8 floats per source).
   * Built once at onAdd — wave sources are level-immutable.
   */
  private waveSourceData!: Float32Array;

  // Current modifier count (updated each frame)
  private modifierCount: number = 0;

  /**
   * Number of modifiers whose AABB overlaps the current render viewport.
   * Visible modifiers are packed at the front of the buffer, so the
   * modifier rasterizer can dispatch only the visible-count of instances
   * and skip rasterizing wakes whose entire footprint is off-screen.
   * Modifiers behind this count remain in the buffer for the water
   * query worker to iterate over (it reads them via the SAB view).
   */
  private visibleModifierCount: number = 0;

  /**
   * Last render viewport handed in by SurfaceRenderer. Used to partition
   * collected modifiers visible-first each tick. Null on the first frame
   * before SurfaceRenderer has rendered — in that case all modifiers are
   * treated as visible (no culling).
   */
  private renderViewport: Viewport | null = null;

  // Tide height offset (updated each tick)
  private tideHeight: number = 0;

  // Cached modifier data for current frame (for render pipeline access)
  private cachedModifiers: GPUWaterModifierData[] = [];

  constructor(waveConfig?: WaveConfig) {
    super();
    this.waveConfig = waveConfig ?? DEFAULT_WAVE_CONFIG;
  }

  @on("add")
  onAdd({ game }: GameEventMap["add"]): void {
    const device = game.getWebGPUDevice();
    // Create wave data storage buffer (static, uploaded once)
    this.waveSourceData = buildWaveDataFromSources(this.waveConfig.sources);
    this.waveDataBuffer = device.createBuffer({
      size: this.waveSourceData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: "Water Wave Data Buffer (Shared)",
      mappedAtCreation: true,
    });
    new Float32Array(this.waveDataBuffer.getMappedRange()).set(
      this.waveSourceData,
    );
    this.waveDataBuffer.unmap();

    // Modifier buffer: SAB-backed so the CPU query worker can read it
    // live each frame. GPU uploads happen via `device.queue.writeBuffer`
    // as before — that function copies into GPU memory regardless of
    // whether the source is a SAB or a plain ArrayBuffer.
    this.modifierDataSab = new SharedArrayBuffer(
      MAX_MODIFIERS * FLOATS_PER_MODIFIER * Float32Array.BYTES_PER_ELEMENT,
    );
    this.modifierData = new Float32Array(this.modifierDataSab);
    this.modifiersBuffer = device.createBuffer({
      size: this.modifierData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: "Water Modifiers Buffer (Shared)",
    });
  }

  /**
   * SAB-backed view of the current frame's modifier data. Handed to the
   * query worker pool; readers see updates as soon as `updateModifiers`
   * writes them each frame.
   */
  getModifierDataSab(): SharedArrayBuffer {
    return this.modifierDataSab;
  }

  /**
   * Wave source parameters as a Float32Array (8 floats per source).
   * Level-immutable.
   */
  getWaveSourceData(): Float32Array {
    return this.waveSourceData;
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
   *
   * Modifiers are partitioned visible-first based on the current render
   * viewport so the rasterizer can dispatch only `visibleModifierCount`
   * instances. Off-screen modifiers remain in the buffer (after the
   * visible ones) for the GPU water query path to read.
   */
  private updateModifiers(modifiers: GPUWaterModifierData[]): number {
    const device = this.game.getWebGPUDevice();
    const modifierCount = Math.min(modifiers.length, MAX_MODIFIERS);

    if (modifiers.length > MAX_MODIFIERS) {
      console.warn(
        `Water modifiers (${modifiers.length}) exceeds MAX_MODIFIERS (${MAX_MODIFIERS}), truncating`,
      );
    }

    // Partition visible-first (Lomuto-style in-place). Without a viewport
    // (first frame), treat every modifier as visible.
    const viewport = this.renderViewport;
    let visibleCount = 0;
    if (viewport) {
      const left = viewport.left;
      const right = viewport.left + viewport.width;
      const top = viewport.top;
      const bottom = viewport.top + viewport.height;
      let writeIdx = 0;
      for (let i = 0; i < modifierCount; i++) {
        const b = modifiers[i].bounds;
        const visible = !(
          b.upperBound.x < left ||
          b.lowerBound.x > right ||
          b.upperBound.y < top ||
          b.lowerBound.y > bottom
        );
        if (visible) {
          if (i !== writeIdx) {
            const tmp = modifiers[writeIdx];
            modifiers[writeIdx] = modifiers[i];
            modifiers[i] = tmp;
          }
          writeIdx++;
        }
      }
      visibleCount = writeIdx;
    } else {
      visibleCount = modifierCount;
    }
    this.visibleModifierCount = visibleCount;

    for (let i = 0; i < modifierCount; i++) {
      const mod = modifiers[i];
      const base = i * FLOATS_PER_MODIFIER;

      // Header: type + bounds (AABB)
      this.modifierData[base + 0] = mod.type;
      this.modifierData[base + 1] = mod.bounds.lowerBound.x;
      this.modifierData[base + 2] = mod.bounds.lowerBound.y;
      this.modifierData[base + 3] = mod.bounds.upperBound.x;
      this.modifierData[base + 4] = mod.bounds.upperBound.y;

      // Pack type-specific data (see FLOATS_PER_MODIFIER comment for layout)
      const d = mod.data;
      if (d.type === WaterModifierType.Wake) {
        this.modifierData[base + 5] = d.posX;
        this.modifierData[base + 6] = d.posY;
        this.modifierData[base + 7] = d.ringRadius;
        this.modifierData[base + 8] = d.ringWidth;
        this.modifierData[base + 9] = d.amplitude;
        this.modifierData[base + 10] = d.omega;
        this.modifierData[base + 11] = 0;
        this.modifierData[base + 12] = 0;
        this.modifierData[base + 13] = 0;
      } else {
        // Foam
        this.modifierData[base + 5] = d.posX;
        this.modifierData[base + 6] = d.posY;
        this.modifierData[base + 7] = d.radius;
        this.modifierData[base + 8] = d.intensity;
        this.modifierData[base + 9] = 0;
        this.modifierData[base + 10] = 0;
        this.modifierData[base + 11] = 0;
        this.modifierData[base + 12] = 0;
        this.modifierData[base + 13] = 0;
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
   * Get the number of modifiers visible in the current render viewport.
   * Visible modifiers are packed at the front of the buffer, so the
   * modifier rasterizer dispatches this count of instances. Off-screen
   * modifiers occupy positions [visibleCount, modifierCount) and stay
   * available to the water query worker.
   */
  getVisibleModifierCount(): number {
    return this.visibleModifierCount;
  }

  /**
   * Inform WaterResources of the current render viewport so the next
   * tick's modifier upload can partition visible-first. Called from
   * SurfaceRenderer each frame. Pass null to disable culling.
   */
  setRenderViewport(viewport: Viewport | null): void {
    this.renderViewport = viewport;
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
