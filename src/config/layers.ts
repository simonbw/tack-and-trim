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
  waterShader: new LayerInfo({ parallax: V(0, 0) }), // don't move water, shader does the work for us
  wake: new LayerInfo(),
  foamParticles: new LayerInfo(), // Foam on water surface
  sprayParticles: new LayerInfo(), // Spray particles above wake but below hull

  underhull: new LayerInfo(),
  hull: new LayerInfo(),
  main: new LayerInfo(),
  sails: new LayerInfo(),
  telltails: new LayerInfo(),

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
export const DEFAULT_LAYER: LayerName = "main";
