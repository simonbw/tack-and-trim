/**
 * Coastline Manager
 *
 * Manages height=0 coastline contours for wave physics computation.
 * Provides:
 * - Filtering contours to identify coastlines
 * - Bounding box computation per coastline
 * - Coastline indices for GPU buffer upload
 */

import { V2d } from "../../core/Vector";
import type {
  TerrainContour,
  TerrainDefinition,
} from "../world/terrain/LandMass";

/**
 * Axis-aligned bounding box.
 */
export interface AABB {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * Information about a single coastline contour.
 */
export interface CoastlineInfo {
  /** Index into the original contours array */
  contourIndex: number;
  /** The coastline contour data */
  contour: TerrainContour;
  /** Bounding box of the coastline */
  bounds: AABB;
}

/**
 * Manages coastline contours for wave physics.
 */
export class CoastlineManager {
  private coastlines: CoastlineInfo[] = [];
  private coastlineIndices: number[] = [];

  /**
   * Initialize the coastline manager from a terrain definition.
   * Finds all height=0 contours and computes their bounding boxes.
   */
  initialize(terrainDef: TerrainDefinition): void {
    this.coastlines = [];
    this.coastlineIndices = [];

    for (let i = 0; i < terrainDef.contours.length; i++) {
      const contour = terrainDef.contours[i];

      // Coastlines are defined as height=0 contours
      if (contour.height === 0) {
        const bounds = this.computeBounds(contour.sampledPolygon);
        this.coastlines.push({
          contourIndex: i,
          contour,
          bounds,
        });
        this.coastlineIndices.push(i);
      }
    }
  }

  /**
   * Compute the bounding box from pre-sampled polygon points.
   */
  private computeBounds(sampledPolygon: readonly V2d[]): AABB {
    if (sampledPolygon.length === 0) {
      return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const pt of sampledPolygon) {
      minX = Math.min(minX, pt.x);
      maxX = Math.max(maxX, pt.x);
      minY = Math.min(minY, pt.y);
      maxY = Math.max(maxY, pt.y);
    }

    return { minX, maxX, minY, maxY };
  }

  /**
   * Get all coastline information.
   */
  getCoastlines(): readonly CoastlineInfo[] {
    return this.coastlines;
  }

  /**
   * Get coastline indices for GPU upload.
   */
  getCoastlineIndices(): readonly number[] {
    return this.coastlineIndices;
  }

  /**
   * Get the number of coastlines.
   */
  getCoastlineCount(): number {
    return this.coastlines.length;
  }

  /**
   * Check if a point is potentially near any coastline using bounding boxes.
   * Used for early rejection in expensive computations.
   *
   * @param point - World position to check
   * @param margin - Additional margin around bounding boxes
   * @returns Array of coastline infos that might contain the point
   */
  getPotentialCoastlines(point: V2d, margin: number = 0): CoastlineInfo[] {
    const result: CoastlineInfo[] = [];

    for (const coastline of this.coastlines) {
      const { bounds } = coastline;
      if (
        point.x >= bounds.minX - margin &&
        point.x <= bounds.maxX + margin &&
        point.y >= bounds.minY - margin &&
        point.y <= bounds.maxY + margin
      ) {
        result.push(coastline);
      }
    }

    return result;
  }

  /**
   * Get the combined bounding box of all coastlines.
   */
  getCombinedBounds(): AABB | null {
    if (this.coastlines.length === 0) {
      return null;
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const coastline of this.coastlines) {
      minX = Math.min(minX, coastline.bounds.minX);
      maxX = Math.max(maxX, coastline.bounds.maxX);
      minY = Math.min(minY, coastline.bounds.minY);
      maxY = Math.max(maxY, coastline.bounds.maxY);
    }

    return { minX, maxX, minY, maxY };
  }

  /**
   * Clear all coastline data.
   */
  clear(): void {
    this.coastlines = [];
    this.coastlineIndices = [];
  }
}
