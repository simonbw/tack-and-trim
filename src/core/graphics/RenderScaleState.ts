/**
 * User preference for render-scale (multiplier on devicePixelRatio).
 *
 * The whole renderer keys off `pixelRatio` for canvas and main render-target
 * sizing, so reducing the scale shrinks every fragment-shaded pass uniformly.
 * On a retina display, "high" (1.0×) is the device's native DPR; "low" (0.5×)
 * makes the renderer effectively 1× DPR on retina.
 *
 * Persists to localStorage. Subscribers fire synchronously; RenderManager
 * triggers a resize() so all canvas-sized targets are recreated at the new
 * physical pixel count.
 */

import { createPersistedState } from "../state/PersistedState";

export type RenderScale = "low" | "medium" | "high";

const FACTORS: Record<RenderScale, number> = {
  low: 0.5,
  medium: 0.75,
  high: 1.0,
};

const state = createPersistedState<RenderScale>({
  key: "renderScale",
  default: "high",
  validate: (v) => (v === "low" || v === "medium" || v === "high" ? v : null),
});

export function getRenderScale(): RenderScale {
  return state.get();
}

/** Multiplier applied to devicePixelRatio when resizing the canvas. */
export function getRenderScaleFactor(): number {
  return FACTORS[state.get()];
}

export function setRenderScale(s: RenderScale): void {
  state.set(s);
}

export function onRenderScaleChange(cb: () => void): () => void {
  return state.subscribe(cb);
}
