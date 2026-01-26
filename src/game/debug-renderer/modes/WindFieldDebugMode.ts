/**
 * Wind Field debug mode.
 *
 * Shows wind triangles and modifier areas, reusing WorldSpaceWindVisualization.
 */

import type { DebugRenderMode, DebugRenderContext } from "../DebugRenderMode";
import { WindInfo } from "../../world-data/wind/WindInfo";
import { WorldSpaceWindVisualization } from "../../wind-visualization/WorldSpaceWindVisualization";

// Dim overlay
const DIM_COLOR = 0x000000;
const DIM_ALPHA = 0.4;

// Modifier area styling
const MODIFIER_FILL_COLOR = 0xffaa44;
const MODIFIER_FILL_ALPHA = 0.15;

// Convert radians to compass direction
function radiansToCompass(radians: number): string {
  // Normalize to 0-2π
  const normalized = ((radians % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  // Convert to degrees (0° = East, going counter-clockwise)
  const degrees = (normalized * 180) / Math.PI;
  // Convert to compass (0° = North, going clockwise)
  // Wind direction in this system: 0 = right (East), π/2 = down (South)
  const compassDeg = (90 - degrees + 360) % 360;

  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const index = Math.round(compassDeg / 45) % 8;
  return directions[index];
}

export class WindFieldDebugMode implements DebugRenderMode {
  id = "windField";
  name = "Wind Field";

  private worldSpaceViz = new WorldSpaceWindVisualization();

  render(ctx: DebugRenderContext): void {
    const wind = WindInfo.maybeFromGame(ctx.game);
    if (!wind) return;

    const camera = ctx.game.camera;
    const viewport = camera.getWorldViewport();

    // Draw dim overlay
    ctx.draw.fillRect(
      viewport.left,
      viewport.top,
      viewport.width,
      viewport.height,
      {
        color: DIM_COLOR,
        alpha: DIM_ALPHA,
      },
    );

    // Draw modifier areas
    for (const modifier of wind.getModifiers()) {
      const aabb = modifier.getWindModifierAABB();
      ctx.draw.fillRect(
        aabb.minX,
        aabb.minY,
        aabb.maxX - aabb.minX,
        aabb.maxY - aabb.minY,
        {
          color: MODIFIER_FILL_COLOR,
          alpha: MODIFIER_FILL_ALPHA,
        },
      );
    }

    // Delegate to world-space wind visualization
    this.worldSpaceViz.draw(wind, viewport, camera, ctx.draw);
  }

  getCursorInfo(ctx: DebugRenderContext): string | null {
    if (!ctx.cursorWorldPos) return null;

    const wind = WindInfo.maybeFromGame(ctx.game);
    if (!wind) return null;

    const velocity = wind.getVelocityAtPoint(ctx.cursorWorldPos);
    const speed = velocity.magnitude;
    const direction = velocity.angle;

    const compass = radiansToCompass(direction);
    return `Wind: ${speed.toFixed(0)} ft/s ${compass}`;
  }
}
