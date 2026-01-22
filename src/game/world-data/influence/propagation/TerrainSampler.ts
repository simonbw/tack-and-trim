import { V2d } from "../../../../core/Vector";
import { TerrainComputeCPU } from "../../terrain/cpu/TerrainComputeCPU";
import { LandMass, TerrainDefinition } from "../../terrain/LandMass";

/**
 * Cached land mass with pre-computed polyline.
 */
interface CachedLandMass {
  landMass: LandMass;
  polyline: V2d[];
}

/**
 * TerrainSampler provides efficient terrain queries for influence field propagation.
 *
 * The propagation algorithms iterate over ~10,000 grid cells and need fast
 * land/water determination and shore distance queries. This class:
 *
 * 1. Pre-subdivides Catmull-Rom splines into polylines at construction time
 * 2. Caches polylines for repeated queries
 * 3. Provides simple boolean land/water checks
 *
 * Why not use TerrainInfo directly?
 * - TerrainInfo.getShoreDistance() recomputes splines on every call
 * - TerrainSampler caches the subdivision work for batch queries
 * - For 10,000 queries × N land masses, this avoids redundant subdivision
 */
export class TerrainSampler {
  private readonly compute: TerrainComputeCPU;
  private readonly cachedLandMasses: CachedLandMass[];

  constructor(definition: TerrainDefinition) {
    this.compute = new TerrainComputeCPU();

    // Pre-subdivide splines for efficient repeated queries
    this.cachedLandMasses = definition.landMasses.map((landMass) => ({
      landMass,
      polyline: this.compute.subdivideSpline(landMass.controlPoints),
    }));
  }

  /**
   * Check if a point is on land (inside any land mass).
   */
  isLand(point: V2d): boolean {
    return this.getShoreDistance(point) < 0;
  }

  /**
   * Check if a point is in water (outside all land masses).
   */
  isWater(point: V2d): boolean {
    return this.getShoreDistance(point) >= 0;
  }

  /**
   * Get signed distance from a point to the nearest coastline.
   * Positive = in water, Negative = on land.
   *
   * Uses cached polylines for efficiency during batch queries.
   */
  getShoreDistance(point: V2d): number {
    let minDist = 10000;
    for (const cached of this.cachedLandMasses) {
      const dist = this.compute.computeSignedDistanceFromPolyline(
        point,
        cached.polyline,
      );
      minDist = Math.min(minDist, dist);
    }
    return minDist;
  }

  /**
   * Get absolute distance from a point to the nearest coastline.
   * Always positive, regardless of whether the point is on land or water.
   */
  getAbsoluteShoreDistance(point: V2d): number {
    return Math.abs(this.getShoreDistance(point));
  }

  /**
   * Get the number of land masses being sampled.
   */
  getLandMassCount(): number {
    return this.cachedLandMasses.length;
  }
}
