/**
 * Runtime master volume. Applied to the `masterGain` node on the Game's
 * AudioContext so it scales every sound uniformly.
 *
 * Setting persists to localStorage so the choice survives reloads.
 * Subscribers fire synchronously on change.
 */

import { createPersistedState } from "../state/PersistedState";

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

const state = createPersistedState<number>({
  key: "masterVolume",
  default: 1,
  validate: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return clamp01(n);
  },
});

export function getMasterVolume(): number {
  return state.get();
}

export function setMasterVolume(volume: number): void {
  state.set(clamp01(volume));
}

export function onMasterVolumeChange(cb: (volume: number) => void): () => void {
  return state.subscribe(cb);
}
