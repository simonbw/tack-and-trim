/**
 * Runtime MSAA state. Lets the renderer and every MSAA-aware pipeline owner
 * rebuild in sync when the user toggles antialiasing on or off.
 *
 * Setting persists to localStorage so the choice survives reloads.
 * Subscribers fire synchronously; they are expected to destroy their old
 * pipeline (textures stay the same) and create a new one at the current
 * sample count. The renderer also destroys/recreates MSAA color and depth
 * textures at the new sample count as part of its own subscriber.
 */

type Unsubscribe = () => void;

const KEY = "msaa";

let currentSampleCount: 1 | 4 =
  typeof localStorage !== "undefined" && localStorage.getItem(KEY) === "off"
    ? 1
    : 4;

const subscribers = new Set<() => void>();

export function getMSAASampleCount(): 1 | 4 {
  return currentSampleCount;
}

export function isMSAAEnabled(): boolean {
  return currentSampleCount > 1;
}

export function setMSAAEnabled(enabled: boolean): void {
  const next: 1 | 4 = enabled ? 4 : 1;
  if (next === currentSampleCount) return;
  currentSampleCount = next;
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(KEY, enabled ? "on" : "off");
  }
  for (const cb of subscribers) cb();
}

export function onMSAAChange(cb: () => void): Unsubscribe {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}
