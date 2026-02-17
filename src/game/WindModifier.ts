import { AABB } from "../core/util/SparseSpatialHash";
import { V2d } from "../core/Vector";

/**
 * Interface for entities that modify the wind field.
 *
 * When a sail generates lift, it creates circulation - air flows faster
 * on the leeward side and slower on the windward side. This interface
 * allows any entity to contribute velocity perturbations to nearby wind queries.
 *
 * The Wind class sums contributions from all registered modifiers when
 * computing wind velocity at any point, enabling emergent effects like:
 * - Slot effect (jib accelerates air for mainsail)
 * - Wind shadow (sails block wind from competitors)
 * - Stall turbulence (disturbed air downstream of stalled sails)
 */
export interface WindModifier {
  /** Get the axis-aligned bounding box of this modifier's influence area. */
  getWindModifierAABB(): AABB;

  /**
   * Calculate the velocity contribution at a query point.
   * This is added to the base wind velocity.
   */
  getWindVelocityContribution(queryPoint: V2d): V2d;
}
