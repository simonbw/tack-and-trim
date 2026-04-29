/**
 * Wind GPU resource manager.
 *
 * Holds wind mesh data (multi-source) and per-source weight state for blended
 * terrain influence. Base wind velocity is owned by `WeatherState`.
 */

import { BaseEntity } from "../../../core/entity/BaseEntity";
import { on } from "../../../core/entity/handler";
import type { WindMeshFileBundle } from "../../../pipeline/mesh-building/WindmeshFile";
import type { WindConfig } from "./WindSource";
import { DEFAULT_WIND_CONFIG } from "./WindSource";
import { MAX_WIND_SOURCES } from "./WindConstants";
import {
  buildPackedWindMeshData,
  createPlaceholderPackedWindMeshData,
  uploadPackedWindMeshBuffer,
} from "../../wind/WindMeshPacking";

/**
 * Manages wind state for the wind query system.
 *
 * Holds multi-source wind mesh data and per-source weights for blended
 * terrain influence lookup.
 */
export class WindResources extends BaseEntity {
  id = "windResources";

  private windMeshData?: WindMeshFileBundle;
  private windConfig: WindConfig;
  private packedWindMeshBuffer: GPUBuffer | null = null;
  private packedWindMeshRaw: Uint32Array | null = null;
  private sourceWeights: number[];

  constructor(windMeshData?: WindMeshFileBundle, windConfig?: WindConfig) {
    super();
    this.windMeshData = windMeshData;
    this.windConfig = windConfig ?? DEFAULT_WIND_CONFIG;
    // Initialize all weights to 0, then set first source to 1.0
    this.sourceWeights = new Array(
      Math.min(this.windConfig.sources.length, MAX_WIND_SOURCES),
    ).fill(0);
    if (this.sourceWeights.length > 0) {
      this.sourceWeights[0] = 1.0;
    }
  }

  @on("add")
  onAdd(): void {
    const device = this.game.getWebGPUDevice();
    this.packedWindMeshRaw = this.windMeshData
      ? buildPackedWindMeshData(this.windMeshData)
      : createPlaceholderPackedWindMeshData();
    this.packedWindMeshBuffer = uploadPackedWindMeshBuffer(
      device,
      this.packedWindMeshRaw,
    );
  }

  getPackedWindMeshBuffer(): GPUBuffer {
    return this.packedWindMeshBuffer!;
  }

  /**
   * Raw CPU-side view of the packed wind mesh. Used by the CPU query
   * backend (worker reads from this via SAB or a postMessage copy).
   */
  getPackedWindMeshRaw(): Uint32Array {
    return this.packedWindMeshRaw!;
  }

  getWindMeshData(): WindMeshFileBundle | undefined {
    return this.windMeshData;
  }

  getWindConfig(): WindConfig {
    return this.windConfig;
  }

  /**
   * Get per-source weights for blended wind mesh lookup.
   */
  getSourceWeights(): number[] {
    return this.sourceWeights;
  }

  /**
   * Set weight for a specific wind source.
   */
  setSourceWeight(sourceIndex: number, weight: number): void {
    if (sourceIndex >= 0 && sourceIndex < this.sourceWeights.length) {
      this.sourceWeights[sourceIndex] = weight;
    }
  }

  /**
   * Set all source weights at once.
   */
  setSourceWeights(weights: number[]): void {
    for (let i = 0; i < this.sourceWeights.length; i++) {
      this.sourceWeights[i] = weights[i] ?? 0;
    }
  }
}
