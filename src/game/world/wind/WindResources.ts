/**
 * Wind GPU resource manager.
 *
 * Holds base wind state (velocity, angle, speed), wind mesh data (multi-source),
 * and per-source weight state for blended terrain influence.
 */

import { BaseEntity } from "../../../core/entity/BaseEntity";
import { on } from "../../../core/entity/handler";
import { V, type V2d } from "../../../core/Vector";
import type { WindMeshFileBundle } from "../../../pipeline/mesh-building/WindmeshFile";
import type { WindConfig } from "./WindSource";
import { DEFAULT_WIND_CONFIG } from "./WindSource";
import { MAX_WIND_SOURCES } from "./WindConstants";
import {
  buildPackedWindMeshBuffer,
  createPlaceholderPackedWindMeshBuffer,
} from "../../wind/WindMeshPacking";

/**
 * Manages wind state for the wind query system.
 *
 * Holds base wind velocity, multi-source wind mesh data, and per-source
 * weights for blended terrain influence lookup.
 */
export class WindResources extends BaseEntity {
  id = "windResources";

  // Base wind velocity - the global wind direction and speed
  // ~15 ft/s (~9 kts), NW breeze
  private baseVelocity: V2d = V(11, 11);

  private windMeshData?: WindMeshFileBundle;
  private windConfig: WindConfig;
  private packedWindMeshBuffer: GPUBuffer | null = null;
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
    if (this.windMeshData) {
      this.packedWindMeshBuffer = buildPackedWindMeshBuffer(
        device,
        this.windMeshData,
      );
    } else {
      this.packedWindMeshBuffer = createPlaceholderPackedWindMeshBuffer(device);
    }
  }

  getPackedWindMeshBuffer(): GPUBuffer {
    return this.packedWindMeshBuffer!;
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

  /**
   * Get the base wind velocity vector.
   */
  getBaseVelocity(): V2d {
    return this.baseVelocity.clone();
  }

  /**
   * Get the base wind speed.
   */
  getSpeed(): number {
    return this.baseVelocity.magnitude;
  }

  /**
   * Get the base wind angle in radians.
   */
  getAngle(): number {
    return this.baseVelocity.angle;
  }

  /**
   * Set the base wind velocity directly.
   */
  setVelocity(velocity: V2d): void {
    this.baseVelocity.set(velocity);
  }

  /**
   * Set the base wind from angle and speed.
   * @param angle Wind direction in radians (0 = east, PI/2 = north)
   * @param speed Wind speed in ft/s
   */
  setFromAngleAndSpeed(angle: number, speed: number): void {
    this.baseVelocity.set(Math.cos(angle) * speed, Math.sin(angle) * speed);
  }
}
