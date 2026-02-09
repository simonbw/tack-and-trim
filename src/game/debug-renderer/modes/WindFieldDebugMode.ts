/**
 * Wind Field debug mode.
 *
 * Shows wind triangles reusing WorldSpaceWindVisualization.
 * Uses WindQuery for GPU-accelerated wind sampling.
 */

import type { GameEventMap } from "../../../core/entity/Entity";
import { on } from "../../../core/entity/handler";
import type { V2d } from "../../../core/Vector";
import { WorldSpaceWindVisualization } from "../../wind-visualization/WorldSpaceWindVisualization";
import { WindQuery } from "../../world/wind/WindQuery";
import { DebugRenderMode } from "./DebugRenderMode";

// Dim overlay
const DIM_COLOR = 0x000000;
const DIM_ALPHA = 0.4;

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
  private windQuery: WindQuery;

  // Cache the query points so we can use them when drawing
  private cachedQueryPoints: V2d[] = [];

  constructor() {
    super();

    // Wind query for grid + cursor positions
    this.windQuery = this.addChild(
      new WindQuery(() => this.getWindQueryPoints()),
    );
  }

  private getWindQueryPoints(): V2d[] {
    if (!this.game) return [];

    const viewport = this.game.camera.getWorldViewport();
    const gridPoints = this.worldSpaceViz.getQueryPoints(viewport);

    // Add cursor position as last point for cursor info
    const mouseWorldPos = this.game.camera.toWorld(this.game.io.mousePosition);
    if (mouseWorldPos) {
      gridPoints.push(mouseWorldPos);
    }

    this.cachedQueryPoints = gridPoints;
    return gridPoints;
  }

  @on("render")
  onRender({ draw }: GameEventMap["render"]): void {
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

    // Draw wind visualization using query results
    if (
      this.windQuery.results.length > 0 &&
      this.cachedQueryPoints.length > 0
    ) {
      // Grid points are all but the last one (cursor)
      const gridPoints = this.cachedQueryPoints.slice(0, -1);
      const gridResults = this.windQuery.results.slice(0, -1);

      this.worldSpaceViz.draw(gridResults, gridPoints, viewport, camera, draw);
    }
  }

  getModeName(): string {
    return "Wind Field";
  }

  getCursorInfo(): string | null {
    const mouseWorldPos = this.game.camera.toWorld(this.game.io.mousePosition);
    if (!mouseWorldPos) return null;

    // Cursor wind is the last result (we add it as last query point)
    if (this.windQuery.results.length === 0) return null;

    const cursorResult =
      this.windQuery.results[this.windQuery.results.length - 1];
    const speed = cursorResult.speed;
    const direction = cursorResult.direction;

    const compass = radiansToCompass(direction);
    return `Wind: ${speed.toFixed(0)} ft/s ${compass}`;
  }
}
