/**
 * Define the layers that entities can tick in.
 * Layers are processed in the order they are defined in this array.
 * The first layer is processed first, and the last layer is processed last.
 */
export const TICK_LAYERS = [
  "input", // Player input handling - processed earliest
  "environment", // Wind/water/terrain resources and stuff
  "query", // Wind/water/terrain query systems - kicks off GPU work early
  "main", // Default layer for most entities
  "effects", // Particle effects (spray, foam, wake)
  "camera", // Camera follows final positions
] as const;

export type TickLayerName = (typeof TICK_LAYERS)[number];

/** The layer that entities that do not specify a tick layer will be added to. */
export const DEFAULT_TICK_LAYER: TickLayerName = "main";
