/**
 * Tidal flow resource manager.
 *
 * Singleton entity that loads the tidal flow mesh and provides packed
 * mesh data + tidal state (phase, strength) to the water query worker
 * pool.
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
  }

  /**
   * Raw CPU-side Uint32Array view of the packed tide mesh data, consumed
   * by the query worker pool.
   */
  getPackedTideMeshRaw(): Uint32Array {
    return this.packedBuffer;
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
        ((timeInSeconds / TIDAL_PERIOD_SECONDS) * Math.PI * 2) % (Math.PI * 2);
    }
  }
}
