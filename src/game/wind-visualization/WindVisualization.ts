import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import { WindInfo } from "../world-data/wind/WindInfo";
import { WindVisualizationMode } from "./WindVisualizationMode";
import { WorldSpaceWindVisualization } from "./WorldSpaceWindVisualization";

// Visualization modes: 0=off, 1=world triangles
type VisualizationModeIndex = 0 | 1;

// Dim overlay
const DIM_COLOR = 0x000000;
const DIM_ALPHA = 0.4;

const MODIFIER_FILL_COLOR = 0xffaa44;
const MODIFIER_FILL_ALPHA = 0.15;

export class WindVisualization extends BaseEntity {
  layer = "windViz" as const;

  private modeIndex: VisualizationModeIndex = 0;
  private modes: (WindVisualizationMode | null)[] = [
    null, // Mode 0 = off
    new WorldSpaceWindVisualization(), // Mode 1 = world triangles
  ];

  constructor() {
    super();
  }

  @on("keyDown")
  onKeyDown({ key }: { key: string }): void {
    if (key === "KeyV") {
      this.toggle();
    }
  }

  private toggle(): void {
    this.modeIndex = ((this.modeIndex + 1) %
      this.modes.length) as VisualizationModeIndex;
  }

  private getWind(): WindInfo | undefined {
    if (!this.game) return undefined;
    return WindInfo.fromGame(this.game);
  }

  @on("render")
  onRender({ draw }: { draw: import("../../core/graphics/Draw").Draw }): void {
    const mode = this.modes[this.modeIndex];
    if (!mode) {
      return;
    }

    const wind = this.getWind();
    if (!wind) return;

    const camera = this.game!.camera;
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

    // Delegate to active mode
    mode.draw(wind, viewport, camera, draw);
  }
}
