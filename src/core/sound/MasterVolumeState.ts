/**
 * Runtime master volume. Applied to the `masterGain` node on the Game's
 * AudioContext so it scales every sound uniformly.
 *
 * Setting persists to localStorage so the choice survives reloads.
 * Subscribers fire synchronously on change.
 */

type Unsubscribe = () => void;

const KEY = "masterVolume";
const DEFAULT_VOLUME = 1;

function load(): number {
  if (typeof localStorage === "undefined") return DEFAULT_VOLUME;
  const raw = localStorage.getItem(KEY);
  if (raw === null) return DEFAULT_VOLUME;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_VOLUME;
  return Math.min(1, Math.max(0, parsed));
}

let currentVolume = load();

const subscribers = new Set<(volume: number) => void>();

export function getMasterVolume(): number {
  return currentVolume;
}

export function setMasterVolume(volume: number): void {
  const next = Math.min(1, Math.max(0, volume));
  if (next === currentVolume) return;
  currentVolume = next;
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(KEY, String(next));
  }
  for (const cb of subscribers) cb(next);
}

export function onMasterVolumeChange(
  cb: (volume: number) => void,
): Unsubscribe {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}
