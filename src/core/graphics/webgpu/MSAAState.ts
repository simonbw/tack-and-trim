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

import { createPersistedState } from "../../state/PersistedState";

const state = createPersistedState<boolean>({
  key: "msaa",
  default: true,
  serialize: (v) => (v ? "on" : "off"),
  validate: (v) => (v === "on" ? true : v === "off" ? false : null),
});

export function getMSAASampleCount(): 1 | 4 {
  return state.get() ? 4 : 1;
}

export function isMSAAEnabled(): boolean {
  return state.get();
}

export function setMSAAEnabled(enabled: boolean): void {
  state.set(enabled);
}

export function onMSAAChange(cb: () => void): () => void {
  return state.subscribe(cb);
}
