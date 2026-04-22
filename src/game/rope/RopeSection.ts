/**
 * A section of rope between two adjacent nodes.
 *
 * This module re-exports the solver-level `CapstanSection` as the canonical
 * section type; the entity layer doesn't need to add any physics-state
 * fields. Visual-only state (oscillator, effective gravity, material-v
 * offset) lives in the render module alongside its own lifecycle.
 */

export type { CapstanSection as RopeSection } from "./capstan";
export { makeSection as makeRopeSection } from "./capstan";
