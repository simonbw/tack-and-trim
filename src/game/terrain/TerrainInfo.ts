/**
 * Terrain data provider for land and underwater topography.
 *
 * Provides elevation queries at any world position, enabling:
 * - Water depth calculation (water surface - terrain elevation)
 * - Grounding detection for boats
 * - Land/water boundary rendering
 */

import BaseEntity from "../../core/entity/BaseEntity";
import Game from "../../core/Game";
import { clamp, lerp } from "../../core/util/MathUtil";
import { V, V2d } from "../../core/Vector";

/**
 * Result of a terrain elevation query.
 */
export interface TerrainQuery {
  /** Terrain height in feet (positive = above water level, negative = below) */
  elevation: number;
  /** Signed distance to nearest shoreline (positive = in water, negative = on land) */
  distanceToShore: number;
}

/**
 * Definition of a land mass with coastline and elevation profile.
 */
export interface LandMass {
  /** Unique identifier for this land mass */
  id: string;
  /** Polygon vertices defining the shoreline (counter-clockwise winding) */
  coastline: V2d[];
  /** Maximum elevation at the center of the land mass (feet above water) */
  peakElevation: number;
  /** How steeply elevation drops off underwater (feet per foot of distance) */
  underwaterSlope: number;
  /** Elevation at the coastline edge (typically slightly negative for beach) */
  baseDepth: number;
}

/**
 * Default deep ocean floor when no land mass covers an area.
 */
const DEFAULT_OCEAN_DEPTH = -100; // feet

/**
 * How far inland the peak elevation is reached (feet from shore).
 */
const INLAND_PEAK_DISTANCE = 80;

/**
 * Terrain data provider entity.
 */
export class TerrainInfo extends BaseEntity {
  id = "terrainInfo";
  tickLayer = "environment" as const;

  private landMasses: LandMass[] = [];

  /**
   * Get the TerrainInfo entity from a game instance.
   * Throws if not found.
   */
  static fromGame(game: Game): TerrainInfo {
    const terrainInfo = game.entities.getById("terrainInfo");
    if (!(terrainInfo instanceof TerrainInfo)) {
      throw new Error("TerrainInfo not found in game");
    }
    return terrainInfo;
  }

  /**
   * Get the TerrainInfo entity from a game instance, or undefined if not found.
   */
  static maybeFromGame(game: Game): TerrainInfo | undefined {
    const terrainInfo = game.entities.getById("terrainInfo");
    return terrainInfo instanceof TerrainInfo ? terrainInfo : undefined;
  }

  /**
   * Register a land mass.
   */
  addLandMass(landMass: LandMass): void {
    this.landMasses.push(landMass);
  }

  /**
   * Query terrain at a point.
   */
  queryTerrain(point: V2d): TerrainQuery {
    // Find the land mass that affects this point most
    // (closest shoreline if in water, or the one we're inside if on land)
    let bestElevation = DEFAULT_OCEAN_DEPTH;
    let bestDistanceToShore = Infinity;

    for (const landMass of this.landMasses) {
      if (landMass.coastline.length < 3) continue;

      const signedDist = signedDistanceToPolygon(point, landMass.coastline);
      const elevation = this.getElevationForLandMass(signedDist, landMass);

      // Use the highest elevation (shallowest water / highest land)
      if (elevation > bestElevation) {
        bestElevation = elevation;
        bestDistanceToShore = signedDist;
      }
    }

    return {
      elevation: bestElevation,
      distanceToShore: bestDistanceToShore,
    };
  }

  /**
   * Get water depth at a point (convenience method).
   * Returns: waterSurfaceHeight - terrainElevation
   * Positive = underwater, Negative = above water
   */
  getWaterDepth(point: V2d, waterSurfaceHeight: number = 0): number {
    const query = this.queryTerrain(point);
    return waterSurfaceHeight - query.elevation;
  }

  /**
   * Get all land masses (for rendering).
   */
  getLandMasses(): readonly LandMass[] {
    return this.landMasses;
  }

  /**
   * Calculate elevation based on distance to shore for a specific land mass.
   */
  private getElevationForLandMass(
    signedDistance: number,
    landMass: LandMass
  ): number {
    if (signedDistance < 0) {
      // On land - lerp from base to peak based on how far inland
      const inlandDistance = -signedDistance;
      const t = clamp(inlandDistance / INLAND_PEAK_DISTANCE, 0, 1);
      // Use smoothstep for more natural terrain profile
      const smoothT = t * t * (3 - 2 * t);
      return lerp(landMass.baseDepth, landMass.peakElevation, smoothT);
    } else {
      // In water - slope down from baseDepth
      return landMass.baseDepth - signedDistance * landMass.underwaterSlope;
    }
  }
}

/**
 * Calculate signed distance from a point to a polygon.
 * Positive = outside polygon (in water)
 * Negative = inside polygon (on land)
 */
function signedDistanceToPolygon(point: V2d, polygon: V2d[]): number {
  let minDist = Infinity;
  let inside = false;

  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];

    // Distance to this edge
    const dist = pointToSegmentDistance(point, a, b);
    minDist = Math.min(minDist, dist);

    // Ray casting for inside/outside test
    // Cast ray in +X direction, count crossings
    if ((a.y > point.y) !== (b.y > point.y)) {
      const x = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
      if (point.x < x) {
        inside = !inside;
      }
    }
  }

  return inside ? -minDist : minDist;
}

/**
 * Calculate the distance from a point to a line segment.
 */
function pointToSegmentDistance(point: V2d, a: V2d, b: V2d): number {
  const ab = b.sub(a);
  const ap = point.sub(a);

  const abLengthSq = ab.squaredMagnitude;
  if (abLengthSq === 0) {
    // Degenerate segment (a == b)
    return ap.magnitude;
  }

  // Project point onto line, clamped to segment
  const t = clamp(ap.dot(ab) / abLengthSq, 0, 1);

  // Closest point on segment
  const closest = a.add(ab.mul(t));

  return point.distanceTo(closest);
}
