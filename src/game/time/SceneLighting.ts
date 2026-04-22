/**
 * Shared scene-lighting fields for shader uniforms.
 *
 * Every lighting-aware shader receives the same three per-frame values —
 * sun color, sun direction, and sky color — computed once per frame on the
 * CPU by `TimeOfDay`. Each shader spreads these fields into its own uniform
 * struct (both TS and WGSL) and uses `pushSceneLighting` to populate them.
 *
 * Using consistent field names across shaders keeps the lighting vocabulary
 * the same everywhere; values are always derived from `TimeOfDay` so there's
 * one source of truth.
 */

import { vec3 } from "../../core/graphics/UniformStruct";
import type { TimeOfDay } from "./TimeOfDay";

/**
 * Field definitions for embedding in `defineUniformStruct` calls.
 * Spread with `...SCENE_LIGHTING_FIELDS` into the fields record.
 */
export const SCENE_LIGHTING_FIELDS = {
  sunColor: vec3,
  sunDirection: vec3,
  skyColor: vec3,
} as const;

/**
 * WGSL field declarations matching `SCENE_LIGHTING_FIELDS`. Embed inside a
 * hand-written struct body (e.g. between other fields in an inline `Params`
 * struct) via string interpolation.
 *
 * The byte layout is identical to what `defineUniformStruct` produces for
 * the same three vec3 fields, because both sides follow WGSL's std alignment
 * rules (vec3 → 16-byte aligned).
 */
export const SCENE_LIGHTING_WGSL_FIELDS = /*wgsl*/ `
  sunColor: vec3<f32>,
  sunDirection: vec3<f32>,
  skyColor: vec3<f32>,
`;

/** Setter surface that any uniform including the scene-lighting fields exposes. */
export interface SceneLightingSetters {
  sunColor: (v: readonly [number, number, number]) => void;
  sunDirection: (v: readonly [number, number, number]) => void;
  skyColor: (v: readonly [number, number, number]) => void;
}

/**
 * Midday fallback lighting for contexts without a TimeOfDay entity (the
 * level editor, preview renderers, tests). Keeps the world looking sane
 * instead of pitch black.
 */
const NOON_SUN_COLOR: readonly [number, number, number] = [1.0, 0.95, 0.85];
const NOON_SUN_DIRECTION: readonly [number, number, number] = [
  0.316, 0.211, 0.925,
];
const NOON_SKY_COLOR: readonly [number, number, number] = [0.5, 0.7, 0.95];

/**
 * Push current scene lighting into a uniform instance.
 *
 * Call once per frame, before uploading the uniform buffer. Uses
 * `TimeOfDay` values when present (tuples are cached in place, so this is
 * allocation-free), and falls back to noon otherwise so scenes without a
 * TimeOfDay (editor, previews) still render correctly.
 */
export function pushSceneLighting(
  setters: SceneLightingSetters,
  timeOfDay: TimeOfDay | null | undefined,
): void {
  if (timeOfDay) {
    setters.sunColor(timeOfDay.getSunColor());
    setters.sunDirection(timeOfDay.getSunDirection());
    setters.skyColor(timeOfDay.getSkyColor());
  } else {
    setters.sunColor(NOON_SUN_COLOR);
    setters.sunDirection(NOON_SUN_DIRECTION);
    setters.skyColor(NOON_SKY_COLOR);
  }
}
