/**
 * Tidal flow resource manager.
 *
 * Singleton entity that loads tidal flow mesh data and provides GPU buffers
 * and tidal state (phase, strength) for query shaders and rendering.
 *
 * Tidal phase advances based on game-world time from TimeOfDay, following
 * a semi-diurnal tidal cycle (~12.42 hours per cycle).
 */

import { BaseEntity } from "../../../core/entity/BaseEntity";
import { on } from "../../../core/entity/handler";
import type { TideMeshFileData } from "../../../pipeline/mesh-building/TidemeshFile";
import { TimeOfDay } from "../../time/TimeOfDay";
import {
  packTideMeshBuffer,
  createPlaceholderTideMeshBuffer,
} from "./TideMeshPacking";
import { loadTidemeshFromUrl } from "./TidemeshLoader";

/** Semi-diurnal tidal period in seconds (~12.42 hours) */
const TIDAL_PERIOD_SECONDS = 12.42 * 3600;

/**
 * Singleton entity that manages tidal flow mesh data and tidal state.
 */
export class TidalResources extends BaseEntity {
  id = "tidalResources";
  tickLayer = "query" as const;

  private packedBuffer: Uint32Array;
  private gpuBuffer: GPUBuffer | null = null;
  private tidalPhase: number = 0;
  private tidalStrength: number = 1.5; // ft/s max current speed
  private loaded: boolean = false;

  constructor() {
    super();
    this.packedBuffer = createPlaceholderTideMeshBuffer();
  }

  /**
   * Load tidal flow mesh data from a URL.
   */
  async loadTidemesh(url: string): Promise<void> {
    const data: TideMeshFileData = await loadTidemeshFromUrl(url);
    this.packedBuffer = packTideMeshBuffer(data);
    this.loaded = true;
    // GPU buffer will be recreated on next access
    this.gpuBuffer?.destroy();
    this.gpuBuffer = null;
  }

  /**
   * Get or create the packed GPU buffer for binding in query/render shaders.
   */
  getPackedBuffer(device: GPUDevice): GPUBuffer {
    if (!this.gpuBuffer) {
      this.gpuBuffer = device.createBuffer({
        size: this.packedBuffer.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        label: "tidemesh-packed",
      });
      device.queue.writeBuffer(this.gpuBuffer, 0, this.packedBuffer);
    }
    return this.gpuBuffer;
  }

  /**
   * Get the current tidal phase (0..2*PI over one tidal cycle).
   */
  getTidalPhase(): number {
    return this.tidalPhase;
  }

  /**
   * Get the tidal strength scale factor (ft/s).
   */
  getTidalStrength(): number {
    return this.tidalStrength;
  }

  /**
   * Set the tidal strength scale factor (ft/s).
   */
  setTidalStrength(strength: number): void {
    this.tidalStrength = strength;
  }

  /**
   * Whether tidal mesh data has been loaded.
   */
  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Update tidal phase from game-world time each tick.
   *
   * Semi-diurnal tide: ~12.42 hour period.
   * tidalPhase rotates 0..2*PI over one tidal cycle.
   */
  @on("tick")
  onTick() {
    const timeOfDay = this.game.entities.tryGetSingleton(TimeOfDay);
    if (timeOfDay) {
      const timeInSeconds = timeOfDay.getTimeInSeconds();
      this.tidalPhase =
        ((timeInSeconds / TIDAL_PERIOD_SECONDS) * Math.PI * 2) %
        (Math.PI * 2);
    }
  }

  @on("destroy")
  onDestroy(): void {
    this.gpuBuffer?.destroy();
    this.gpuBuffer = null;
  }
}
