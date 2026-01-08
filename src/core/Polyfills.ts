// @ts-nocheck
/*
 * Attach all sorts of hacky stuff to the global state.
 */

import "regenerator-runtime/runtime";

export async function polyfill() {
  if (!window.AudioContext && window.webkitAudioContext) {
    window.AudioContext = window.webkitAudioContext;
  }
}
