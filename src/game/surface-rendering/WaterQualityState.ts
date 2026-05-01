/**
 * User preference for water-height texture resolution. Lower resolution
 * trades visual sharpness in the wave normal/specular for GPU savings on
 * the water-height compute and the water-filter bilinear sample.
 *
 * Persists to localStorage. Subscribers fire synchronously; SurfaceRenderer
 * rebuilds the water-height texture and bind groups on change.
 */

import { createPersistedState } from "../../core/state/PersistedState";

export type WaterQuality = "low" | "medium" | "high";

const SCALES: Record<WaterQuality, number> = {
  low: 0.25,
  medium: 0.5,
  high: 1.0,
};

const state = createPersistedState<WaterQuality>({
  key: "waterQuality",
  default: "medium",
  validate: (v) => (v === "low" || v === "medium" || v === "high" ? v : null),
});

export function getWaterQuality(): WaterQuality {
  return state.get();
}

/** Resolution scale (0..1) applied to the water-height texture. */
export function getWaterQualityScale(): number {
  return SCALES[state.get()];
}

export function setWaterQuality(q: WaterQuality): void {
  state.set(q);
}

export function onWaterQualityChange(cb: () => void): () => void {
  return state.subscribe(cb);
}
