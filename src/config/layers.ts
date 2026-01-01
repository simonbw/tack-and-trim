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
  water: new LayerInfo(),
  wake: new LayerInfo(),

  underhull: new LayerInfo(),
  hull: new LayerInfo(),
  // DEFAULT: The main stuff
  main: new LayerInfo(),

  sails: new LayerInfo(),

  // Stuff not in the world
  hud: new LayerInfo({ paralax: V(0, 0) }),
  // Stuff on the absolute top that's just used for debugging
  debugHud: new LayerInfo({ paralax: V(0, 0) }),
} satisfies { [key: string]: LayerInfo };

/**  */
export type LayerName = keyof typeof LAYERS;

/** The layer that sprites that do not specify a layer will be added to. */
export const DEFAULT_LAYER: LayerName = "main";
