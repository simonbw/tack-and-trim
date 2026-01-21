/**
 * Influence Field System
 *
 * Pre-computed fields that capture how terrain affects wind and waves.
 * These are computed once at game startup from terrain data, then sampled
 * at runtime to determine local conditions.
 *
 * Architecture:
 * - InfluenceFieldGrid: Generic coarse grid for storing per-direction data
 * - PropagationConfig: Parameters controlling energy flow algorithms
 * - Type definitions: WindInfluence, SwellInfluence, etc.
 *
 * See docs/wind-wave-system-design.md for full architecture documentation.
 */

// Types
export {
  type InfluenceGridConfig,
  type WindInfluence,
  type SwellInfluence,
  DEFAULT_WIND_INFLUENCE,
  DEFAULT_SWELL_INFLUENCE,
  WavelengthClass,
  WAVELENGTH_CLASS_COUNT,
  WAVELENGTH_CLASS_VALUES,
  createWindInfluenceArray,
  createSwellInfluenceArray,
} from "./InfluenceFieldTypes";

// Grid data structure
export { InfluenceFieldGrid, createGridConfig } from "./InfluenceFieldGrid";

// Propagation configuration
export {
  type PropagationConfig,
  type InfluenceFieldResolution,
  WIND_PROPAGATION_CONFIG,
  LONG_SWELL_PROPAGATION_CONFIG,
  SHORT_CHOP_PROPAGATION_CONFIG,
  WIND_FIELD_RESOLUTION,
  SWELL_FIELD_RESOLUTION,
  FETCH_FIELD_RESOLUTION,
  validatePropagationConfig,
  createPropagationConfig,
} from "./PropagationConfig";

// Propagation utilities
export { TerrainSampler } from "./propagation/TerrainSampler";

// Propagation algorithms
export {
  type PropagationResult,
  getDirectionVector,
  precomputeWaterMask,
  computeFlowWeight,
  NEIGHBOR_OFFSETS,
  isUpwindBoundary,
  clamp01,
} from "./propagation/PropagationCore";

export {
  type WindPropagationInput,
  computeWindInfluenceField,
} from "./propagation/WindInfluencePropagation";

export {
  type SwellPropagationInput,
  computeSwellInfluenceField,
  computeAllSwellInfluenceFields,
} from "./propagation/SwellInfluencePropagation";

export {
  type FetchComputationInput,
  computeFetchMap,
} from "./propagation/FetchMapComputation";

// Field storage wrappers
export { WindInfluenceField } from "./WindInfluenceField";
export {
  SwellInfluenceField,
  type SwellInfluenceSample,
} from "./SwellInfluenceField";
export { FetchMap } from "./FetchMap";
