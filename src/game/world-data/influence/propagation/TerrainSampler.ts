import { V2d } from "../../../../core/Vector";
import { TerrainComputeCPU } from "../../terrain/cpu/TerrainComputeCPU";
import { TerrainContour, TerrainDefinition } from "../../terrain/LandMass";

/**
 * Cached contour with pre-computed polyline.
 */
interface CachedContour {
  contour: TerrainContour;
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
 * - For 10,000 queries × N contours, this avoids redundant subdivision
 */
export class TerrainSampler {
  private readonly compute: TerrainComputeCPU;
  private readonly cachedContours: CachedContour[];

  constructor(definition: TerrainDefinition) {
    this.compute = new TerrainComputeCPU();

    // Pre-subdivide splines for efficient repeated queries
    this.cachedContours = definition.contours.map((contour) => ({
      contour,
      polyline: this.compute.subdivideSpline(contour.controlPoints),
    }));
  }

  /**
   * Check if a point is on land (inside any contour with height >= 0).
   */
  isLand(point: V2d): boolean {
    return this.getShoreDistance(point) < 0;
  }

  /**
   * Check if a point is in water (outside all shore contours).
   */
  isWater(point: V2d): boolean {
    return this.getShoreDistance(point) >= 0;
  }

  /**
   * Get signed distance from a point to the nearest coastline (height=0 contour).
   * Positive = in water, Negative = on land.
   *
   * Uses cached polylines for efficiency during batch queries.
   */
  getShoreDistance(point: V2d): number {
    let minDist = 10000;

    // First try to find shore contours (height = 0)
    let foundShore = false;
    for (const cached of this.cachedContours) {
      if (cached.contour.height === 0) {
        foundShore = true;
        const dist = this.compute.computeSignedDistanceFromPolyline(
          point,
          cached.polyline,
        );
        minDist = Math.min(minDist, dist);
      }
    }

    // If no shore contours, use all contours
    if (!foundShore) {
      for (const cached of this.cachedContours) {
        const dist = this.compute.computeSignedDistanceFromPolyline(
          point,
          cached.polyline,
        );
        minDist = Math.min(minDist, dist);
      }
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
   * Get the number of contours being sampled.
   */
  getContourCount(): number {
    return this.cachedContours.length;
  }
}
