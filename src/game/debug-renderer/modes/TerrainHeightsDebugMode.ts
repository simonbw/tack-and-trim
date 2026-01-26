/**
 * Terrain Heights debug mode.
 *
 * This mode modifies SurfaceRenderer's internal state rather than
 * rendering an overlay, so the activate/deactivate hooks control
 * the render mode.
 */

import type { DebugRenderMode, DebugRenderContext } from "../DebugRenderMode";
import type { SurfaceRenderer } from "../../surface-rendering/SurfaceRenderer";
import { TerrainInfo } from "../../world-data/terrain/TerrainInfo";

export class TerrainHeightsDebugMode implements DebugRenderMode {
  id = "terrainHeights";
  name = "Terrain Heights";

  render(_ctx: DebugRenderContext): void {
    // No overlay rendering - SurfaceRenderer handles it internally
  }

  onActivate(ctx: DebugRenderContext): void {
    const renderer = ctx.game.entities.getById(
      "waterRenderer",
    ) as SurfaceRenderer | null;
    renderer?.setRenderMode(1);
  }

  onDeactivate(ctx: DebugRenderContext): void {
    const renderer = ctx.game.entities.getById(
      "waterRenderer",
    ) as SurfaceRenderer | null;
    renderer?.setRenderMode(0);
  }

  getCursorInfo(ctx: DebugRenderContext): string | null {
    if (!ctx.cursorWorldPos) return null;

    const terrainInfo = TerrainInfo.maybeFromGame(ctx.game);
    if (!terrainInfo) return null;

    const height = terrainInfo.getHeightAtPoint(ctx.cursorWorldPos);

    if (height > 0) {
      return `Land: ${height.toFixed(1)}ft`;
    } else if (height < 0) {
      return `Water: ${(-height).toFixed(1)}ft deep`;
    } else {
      return `Sea level`;
    }
  }
}
