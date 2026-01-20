import { Camera2d, Viewport } from "../../core/graphics/Camera2d";
import type { Draw } from "../../core/graphics/Draw";
import type { WindInfo } from "../world-data/wind/WindInfo";

export interface WindVisualizationMode {
  /**
   * Draw the visualization.
   */
  draw(wind: WindInfo, viewport: Viewport, camera: Camera2d, draw: Draw): void;
}
