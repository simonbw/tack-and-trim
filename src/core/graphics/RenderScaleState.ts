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

type Unsubscribe = () => void;

export type RenderScale = "low" | "medium" | "high";

const KEY = "renderScale";

const FACTORS: Record<RenderScale, number> = {
  low: 0.5,
  medium: 0.75,
  high: 1.0,
};

function readInitial(): RenderScale {
  if (typeof localStorage === "undefined") return "high";
  const stored = localStorage.getItem(KEY);
  if (stored === "low" || stored === "medium" || stored === "high") {
    return stored;
  }
  return "high";
}

let currentScale: RenderScale = readInitial();

const subscribers = new Set<() => void>();

export function getRenderScale(): RenderScale {
  return currentScale;
}

/** Multiplier applied to devicePixelRatio when resizing the canvas. */
export function getRenderScaleFactor(): number {
  return FACTORS[currentScale];
}

export function setRenderScale(s: RenderScale): void {
  if (s === currentScale) return;
  currentScale = s;
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(KEY, s);
  }
  for (const cb of subscribers) cb();
}

export function onRenderScaleChange(cb: () => void): Unsubscribe {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}
