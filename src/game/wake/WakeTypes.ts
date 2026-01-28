import { AABB } from "../../core/util/SparseSpatialHash";
import { V2d } from "../../core/Vector";

/**
 * Combined water contribution result to avoid redundant distance calculations.
 */
export interface WaterContribution {
  velocityX: number;
  velocityY: number;
  height: number;
  /** Optional rate of height change (dh/dt) in ft/s */
  heightRate?: number;
}

/**
 * Interface for entities that modify the water field.
 */
export interface WaterModifier {
  /** Get the axis-aligned bounding box of this modifier's influence area. */
  getWaterModifierAABB(): AABB;

  /**
   * Calculate all contributions at a query point in one call.
   */
  getWaterContribution(queryPoint: V2d): Readonly<WaterContribution>;
}

/**
 * GPU-friendly segment representation of a wake particle pair.
 */
export interface WakeSegmentData {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  startRadius: number;
  endRadius: number;
  startIntensity: number;
  endIntensity: number;
  startVelX: number;
  startVelY: number;
  endVelX: number;
  endVelY: number;
}
