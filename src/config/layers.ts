import { V } from "../core/Vector";
import { LayerInfo } from "../core/graphics/LayerInfo";

/**
 * Define the layers that sprites can render in.
 * Layers are rendered in the order they are defined in this object.
 * The first layer in this object is rendered first (below everything else),
 * and the last layer is rendered last (on top of everything else).
 */
export const LAYERS = {
  // Rendered first (on the bottom)
  // Boat renders FIRST with depth read-write. Intra-boat depth testing works
  // (deck covers keel, rigging over hull, etc). Depth buffer cleared to 0.
  boat: new LayerInfo({ depth: "read-write" }),

  // Surface renders AFTER the boat. Reads the depth buffer (boat z-heights) to
  // blend water over submerged boat parts with alpha based on submersion depth.
  // Terrain and deep water (no boat) render opaque. Shallow submersion is translucent.
  surface: new LayerInfo({ depth: "read-write" }),

  wake: new LayerInfo(),
  trees: new LayerInfo(),

  windParticles: new LayerInfo(),

  // Wind visualization layer (toggled on/off)
  windViz: new LayerInfo({ alpha: 0 }),

  // Stuff not in the world
  hud: new LayerInfo({ parallax: V(0, 0) }),
  // Stuff on the absolute top that's just used for debugging
  debugHud: new LayerInfo({ parallax: V(0, 0) }),
} satisfies { [key: string]: LayerInfo };

/**  */
export type LayerName = keyof typeof LAYERS;

/** The layer that sprites that do not specify a layer will be added to. */
export const DEFAULT_LAYER: LayerName = "boat";
