/**
 * Wind Field debug mode.
 *
 * Shows wind triangles and modifier areas, reusing WorldSpaceWindVisualization.
 */

import type { GameEventMap } from "../../../core/entity/Entity";
import { on } from "../../../core/entity/handler";
import { WindInfo } from "../../world-data/wind/WindInfo";
import { WorldSpaceWindVisualization } from "../../wind-visualization/WorldSpaceWindVisualization";
import { DebugRenderMode } from "./DebugRenderMode";

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

export class WindFieldDebugMode extends DebugRenderMode {
  layer = "windViz" as const;
  private worldSpaceViz = new WorldSpaceWindVisualization();

  @on("render")
  onRender({ draw }: GameEventMap["render"]): void {
    const wind = this.game.entities.tryGetSingleton(WindInfo);
    if (!wind) return;

    const camera = this.game.camera;
    const viewport = camera.getWorldViewport();

    // Draw dim overlay
    draw.fillRect(
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
      draw.fillRect(
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
    this.worldSpaceViz.draw(wind, viewport, camera, draw);
  }

  getModeName(): string {
    return "Wind Field";
  }

  getCursorInfo(): string | null {
    const mouseWorldPos = this.game.camera.toWorld(this.game.io.mousePosition);
    if (!mouseWorldPos) return null;

    const wind = this.game.entities.tryGetSingleton(WindInfo);
    if (!wind) return null;

    const velocity = wind.getVelocityAtPoint(mouseWorldPos);
    const speed = velocity.magnitude;
    const direction = velocity.angle;

    const compass = radiansToCompass(direction);
    return `Wind: ${speed.toFixed(0)} ft/s ${compass}`;
  }
}
