/**
 * Interface and context types for debug render modes.
 */

import type { Draw } from "../../core/graphics/Draw";
import type { Game } from "../../core/Game";
import type { V2d } from "../../core/Vector";

/**
 * Context passed to debug render mode methods.
 */
export interface DebugRenderContext {
  game: Game;
  draw: Draw;
  viewport: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  /** Current mouse position in world coordinates, or null if unavailable */
  cursorWorldPos: V2d | null;
}

/**
 * Interface for debug visualization modes.
 * Each mode handles its own rendering and optional keyboard input.
 */
export interface DebugRenderMode {
  /** Unique identifier for this mode */
  id: string;

  /** Display name for HUD */
  name: string;

  /**
   * Render the debug visualization.
   * Called every frame when this mode is active.
   */
  render(ctx: DebugRenderContext): void;

  /**
   * Handle keyboard input.
   * Return true if the key was consumed.
   */
  onKeyDown?(
    ctx: DebugRenderContext,
    key: string,
    event: KeyboardEvent,
  ): boolean;

  /**
   * Called when this mode becomes active.
   */
  onActivate?(ctx: DebugRenderContext): void;

  /**
   * Called when this mode becomes inactive.
   */
  onDeactivate?(ctx: DebugRenderContext): void;

  /**
   * Get additional HUD info for this mode.
   * Returns null if no additional info.
   */
  getHudInfo?(ctx: DebugRenderContext): string | null;

  /**
   * Get info about the world point under the cursor.
   * Returns null if cursor info isn't relevant for this mode.
   */
  getCursorInfo?(ctx: DebugRenderContext): string | null;

  /**
   * Clean up resources when the debug renderer is destroyed.
   */
  destroy?(): void;
}
