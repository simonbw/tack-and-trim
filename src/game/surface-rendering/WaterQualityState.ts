/**
 * User preference for water-height texture resolution. Lower resolution
 * trades visual sharpness in the wave normal/specular for GPU savings on
 * the water-height compute and the water-filter bilinear sample.
 *
 * Persists to localStorage. Subscribers fire synchronously; SurfaceRenderer
 * rebuilds the water-height texture and bind groups on change.
 */

type Unsubscribe = () => void;

export type WaterQuality = "low" | "medium" | "high";

const KEY = "waterQuality";

const SCALES: Record<WaterQuality, number> = {
  low: 0.25,
  medium: 0.5,
  high: 1.0,
};

function readInitial(): WaterQuality {
  if (typeof localStorage === "undefined") return "medium";
  const stored = localStorage.getItem(KEY);
  if (stored === "low" || stored === "medium" || stored === "high") {
    return stored;
  }
  return "medium";
}

let currentQuality: WaterQuality = readInitial();

const subscribers = new Set<() => void>();

export function getWaterQuality(): WaterQuality {
  return currentQuality;
}

/** Resolution scale (0..1) applied to the water-height texture. */
export function getWaterQualityScale(): number {
  return SCALES[currentQuality];
}

export function setWaterQuality(q: WaterQuality): void {
  if (q === currentQuality) return;
  currentQuality = q;
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(KEY, q);
  }
  for (const cb of subscribers) cb();
}

export function onWaterQualityChange(cb: () => void): Unsubscribe {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}
