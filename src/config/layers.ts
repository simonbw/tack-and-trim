import { V } from "../core/Vector";
import { LayerInfo } from "../core/graphics/LayerInfo";

/** TODO: Document layers */
export const LAYERS = {
  // DEFAULT: The main stuff
  main: new LayerInfo(),
  // Stuff not in the world
  hud: new LayerInfo({ paralax: V(0, 0) }),
  // Stuff on the absolute top that's just used for debugging
  debugHud: new LayerInfo({ paralax: V(0, 0) }),
} satisfies { [key: string]: LayerInfo };

export type LayerName = keyof typeof LAYERS;

/** The layer that sprites that do not specify a layer will be added to. */
export const DEFAULT_LAYER: LayerName = "main";
