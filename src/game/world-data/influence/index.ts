/**
 * Influence Field System
 *
 * Pre-computed fields that capture how terrain affects wind.
 * These are computed once at game startup from terrain data, then sampled
 * at runtime to determine local conditions.
 *
 * Note: Wave physics uses the analytical shadow-based system (WavePhysicsManager),
 * not grid-based propagation.
 *
 * Architecture:
 * - PropagationConfig: Parameters controlling energy flow algorithms
 * - Type definitions: WindInfluence, etc.
 *
 * See docs/wind-wave-system-design.md for full architecture documentation.
 */

// Types
export {
  type DepthGridConfig,
  type InfluenceGridConfig,
  type WindInfluence,
  DEFAULT_WIND_INFLUENCE,
} from "./InfluenceFieldTypes";

// Propagation configuration
export {
  type PropagationConfig,
  type InfluenceFieldResolution,
  WIND_PROPAGATION_CONFIG,
  WIND_FIELD_RESOLUTION,
  DEPTH_FIELD_CELL_SIZE,
  REFERENCE_CELL_SIZE,
  validatePropagationConfig,
  createPropagationConfig,
  scaleDecayForCellSize,
} from "./PropagationConfig";

// Manager entity
export {
  InfluenceFieldManager,
  type TaskProgress,
} from "./InfluenceFieldManager";
