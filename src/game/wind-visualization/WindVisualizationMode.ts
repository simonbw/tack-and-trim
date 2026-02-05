import { Camera2d, Viewport } from "../../core/graphics/Camera2d";
import type { Draw } from "../../core/graphics/Draw";
import type { V2d } from "../../core/Vector";
import type { WindQueryResult } from "../world/wind/WindQuery";

export interface WindVisualizationMode {
  /**
   * Get the points that need wind queries for a given viewport.
   */
  getQueryPoints(viewport: Viewport): V2d[];

  /**
   * Draw the visualization using pre-queried wind results.
   */
  draw(
    results: WindQueryResult[],
    points: V2d[],
    viewport: Viewport,
    camera: Camera2d,
    draw: Draw,
  ): void;
}
