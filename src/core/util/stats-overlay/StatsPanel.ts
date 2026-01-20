import type { VNode } from "preact";
import type { Game } from "../../Game";

/**
 * Context passed to each panel for rendering and event handling.
 */
export interface StatsPanelContext {
  /** The game instance for accessing entities, world, renderer, etc. */
  game: Game;
  /** Smoothed FPS from frame timing */
  fps: number;
  /** Screen refresh rate FPS */
  fps2: number;
}

/**
 * Interface for stats overlay panels.
 * Each panel is self-contained with its own rendering, data fetching, and input handling.
 */
export interface StatsPanel {
  /** Unique identifier for the panel */
  id: string;

  /** Render the panel content */
  render(ctx: StatsPanelContext): VNode;

  /**
   * Optional keyboard handler.
   * @returns true if the key was handled, false otherwise
   */
  onKeyDown?(
    ctx: StatsPanelContext,
    key: string,
    event: KeyboardEvent,
  ): boolean;
}
