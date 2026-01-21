/**
 * Influence Field Manager
 *
 * Runs terrain-based propagation algorithms at game startup and provides
 * a sampling interface for wind/wave systems to query local conditions.
 *
 * Computes three types of influence fields:
 * - Wind influence: how terrain blocks and deflects wind
 * - Swell influence: how terrain affects wave propagation (diffraction)
 * - Fetch map: how far wind can blow over open water
 */

import { BaseEntity } from "../../../core/entity/BaseEntity";
import { on } from "../../../core/entity/handler";
import { Game } from "../../../core/Game";
import { TerrainInfo } from "../terrain/TerrainInfo";
import { createGridConfig } from "./InfluenceFieldGrid";
import {
  DEFAULT_SWELL_INFLUENCE,
  DEFAULT_WIND_INFLUENCE,
  type WindInfluence,
} from "./InfluenceFieldTypes";
import { FetchMap } from "./FetchMap";
import {
  FETCH_FIELD_RESOLUTION,
  SWELL_FIELD_RESOLUTION,
  WIND_FIELD_RESOLUTION,
} from "./PropagationConfig";
import { computeFetchMap } from "./propagation/FetchMapComputation";
import { computeAllSwellInfluenceFields } from "./propagation/SwellInfluencePropagation";
import { TerrainSampler } from "./propagation/TerrainSampler";
import { computeWindInfluenceField } from "./propagation/WindInfluencePropagation";
import {
  SwellInfluenceField,
  type SwellInfluenceSample,
} from "./SwellInfluenceField";
import { WindInfluenceField } from "./WindInfluenceField";

/** Padding added around terrain bounds for influence field computation */
const BOUNDS_PADDING = 2000;

/**
 * Manages pre-computed influence fields for terrain effects on wind and waves.
 *
 * Usage:
 * ```typescript
 * const manager = InfluenceFieldManager.fromGame(game);
 * const windInfluence = manager.sampleWindInfluence(x, y, windDirection);
 * const swellInfluence = manager.sampleSwellInfluence(x, y, swellDirection);
 * const fetch = manager.sampleFetch(x, y, windDirection);
 * ```
 */
export class InfluenceFieldManager extends BaseEntity {
  id = "influenceFieldManager";
  tickLayer = "environment" as const;

  // Stored fields (populated in onAfterAdded)
  private windField: WindInfluenceField | null = null;
  private swellField: SwellInfluenceField | null = null;
  private fetchMap: FetchMap | null = null;
  private propagationTimeMs: number = 0;

  /**
   * Get the InfluenceFieldManager entity from a game instance.
   * Throws if not found.
   */
  static fromGame(game: Game): InfluenceFieldManager {
    const manager = game.entities.getById("influenceFieldManager");
    if (!(manager instanceof InfluenceFieldManager)) {
      throw new Error("InfluenceFieldManager not found in game");
    }
    return manager;
  }

  /**
   * Get the InfluenceFieldManager entity from a game instance, or undefined if not found.
   */
  static maybeFromGame(game: Game): InfluenceFieldManager | undefined {
    const manager = game.entities.getById("influenceFieldManager");
    return manager instanceof InfluenceFieldManager ? manager : undefined;
  }

  @on("afterAdded")
  onAfterAdded() {
    const startTime = performance.now();

    // Get terrain info
    const terrain = TerrainInfo.fromGame(this.game!);
    const landMasses = terrain.getLandMasses();

    // Compute bounds from all control points
    let minX = Infinity,
      maxX = -Infinity;
    let minY = Infinity,
      maxY = -Infinity;

    for (const lm of landMasses) {
      for (const pt of lm.controlPoints) {
        minX = Math.min(minX, pt.x);
        maxX = Math.max(maxX, pt.x);
        minY = Math.min(minY, pt.y);
        maxY = Math.max(maxY, pt.y);
      }
    }

    // If no land masses, use a default area
    if (!Number.isFinite(minX)) {
      minX = -500;
      maxX = 500;
      minY = -500;
      maxY = 500;
    }

    // Add padding for influence to extend beyond terrain
    minX -= BOUNDS_PADDING;
    maxX += BOUNDS_PADDING;
    minY -= BOUNDS_PADDING;
    maxY += BOUNDS_PADDING;

    // Create terrain sampler for propagation algorithms
    const sampler = new TerrainSampler({ landMasses: [...landMasses] });

    // Create grid configs with appropriate resolutions
    const windGridConfig = createGridConfig(
      minX,
      maxX,
      minY,
      maxY,
      WIND_FIELD_RESOLUTION.cellSize,
      WIND_FIELD_RESOLUTION.directionCount,
    );

    const swellGridConfig = createGridConfig(
      minX,
      maxX,
      minY,
      maxY,
      SWELL_FIELD_RESOLUTION.cellSize,
      SWELL_FIELD_RESOLUTION.directionCount,
    );

    const fetchGridConfig = createGridConfig(
      minX,
      maxX,
      minY,
      maxY,
      FETCH_FIELD_RESOLUTION.cellSize,
      FETCH_FIELD_RESOLUTION.directionCount,
    );

    // Run propagation algorithms
    const windGrid = computeWindInfluenceField({
      terrain: sampler,
      gridConfig: windGridConfig,
    });
    this.windField = new WindInfluenceField(windGrid);

    const swellGrids = computeAllSwellInfluenceFields(sampler, swellGridConfig);
    this.swellField = new SwellInfluenceField(swellGrids[0], swellGrids[1]);

    const fetchGrid = computeFetchMap({
      terrain: sampler,
      gridConfig: fetchGridConfig,
    });
    this.fetchMap = new FetchMap(fetchGrid);

    const elapsed = performance.now() - startTime;
    this.propagationTimeMs = elapsed;
    console.log(
      `Influence field propagation complete: ${elapsed.toFixed(0)}ms`,
    );
  }

  /**
   * Sample wind influence at a world position for a given wind direction.
   *
   * @param worldX - World X coordinate in ft
   * @param worldY - World Y coordinate in ft
   * @param windDirection - Wind source direction in radians
   * @returns Wind influence at this position (speedFactor, directionOffset, turbulence)
   */
  sampleWindInfluence(
    worldX: number,
    worldY: number,
    windDirection: number,
  ): WindInfluence {
    if (!this.windField) return DEFAULT_WIND_INFLUENCE;
    return this.windField.sample(worldX, worldY, windDirection);
  }

  /**
   * Sample swell influence at a world position for a given swell direction.
   *
   * @param worldX - World X coordinate in ft
   * @param worldY - World Y coordinate in ft
   * @param swellDirection - Swell source direction in radians
   * @returns Swell influence for both wavelength classes
   */
  sampleSwellInfluence(
    worldX: number,
    worldY: number,
    swellDirection: number,
  ): SwellInfluenceSample {
    if (!this.swellField) {
      return {
        longSwell: DEFAULT_SWELL_INFLUENCE,
        shortChop: DEFAULT_SWELL_INFLUENCE,
      };
    }
    return this.swellField.sampleAll(worldX, worldY, swellDirection);
  }

  /**
   * Sample fetch distance at a world position for a given wind direction.
   *
   * Fetch is the distance wind has traveled over open water, which affects
   * wave development - longer fetch produces larger waves.
   *
   * @param worldX - World X coordinate in ft
   * @param worldY - World Y coordinate in ft
   * @param windDirection - Wind source direction in radians
   * @returns Fetch distance in ft
   */
  sampleFetch(worldX: number, worldY: number, windDirection: number): number {
    if (!this.fetchMap) return 0;
    return this.fetchMap.sample(worldX, worldY, windDirection);
  }

  /**
   * Check if the influence fields have been computed.
   */
  isInitialized(): boolean {
    return (
      this.windField !== null &&
      this.swellField !== null &&
      this.fetchMap !== null
    );
  }

  /**
   * Get the wind influence field for direct access (e.g., visualization).
   */
  getWindField(): WindInfluenceField | null {
    return this.windField;
  }

  /**
   * Get the swell influence field for direct access (e.g., visualization).
   */
  getSwellField(): SwellInfluenceField | null {
    return this.swellField;
  }

  /**
   * Get the fetch map for direct access (e.g., visualization).
   */
  getFetchMap(): FetchMap | null {
    return this.fetchMap;
  }

  /**
   * Get the time taken to compute all propagation fields in milliseconds.
   * Useful for performance monitoring and testing.
   */
  getPropagationTimeMs(): number {
    return this.propagationTimeMs;
  }
}
