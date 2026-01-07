import { AABB } from "../../core/util/SparseSpatialHash";
import { V2d } from "../../core/Vector";

/**
 * Combined water contribution result to avoid redundant distance calculations.
 */
export interface WaterContribution {
  velocityX: number;
  velocityY: number;
  height: number;
}

/**
 * Interface for entities that modify the water field.
 *
 * Water modifiers contribute to the water state at nearby points,
 * enabling effects like:
 * - Wake particles (height displacement and velocity from boat movement)
 * - Anchor splashes
 * - Underwater currents from moving objects
 *
 * The WaterInfo class sums contributions from all registered modifiers
 * when computing water state at any point.
 */
export interface WaterModifier {
  /** Get the axis-aligned bounding box of this modifier's influence area. */
  getWaterModifierAABB(): AABB;

  /**
   * Calculate all contributions at a query point in one call.
   * More efficient than separate calls since distance is computed once.
   */
  getWaterContribution(queryPoint: V2d): WaterContribution;
}
