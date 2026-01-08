import { Camera2d, Viewport } from "../../core/graphics/Camera2d";
import { Renderer } from "../../core/graphics/Renderer";
import { Wind } from "../Wind";

export interface WindVisualizationMode {
  /**
   * Draw the visualization.
   */
  draw(wind: Wind, viewport: Viewport, camera: Camera2d, renderer: Renderer): void;
}
