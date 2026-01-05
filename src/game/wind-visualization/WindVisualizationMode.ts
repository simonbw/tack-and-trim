import { Container, Renderer } from "pixi.js";
import { Camera2d, Viewport } from "../../core/graphics/Camera2d";
import { Wind } from "../Wind";

export interface WindVisualizationMode {
  /**
   * Draw the visualization.
   * Modes manage their own sprites/graphics within the provided container.
   */
  draw(
    wind: Wind,
    viewport: Viewport,
    camera: Camera2d,
    container: Container,
    renderer: Renderer
  ): void;

  /**
   * Hide all visuals (called when switching away from this mode).
   */
  hide(): void;
}
