import { Container, Graphics, Sprite, Texture } from "pixi.js";
import { LAYERS } from "../../config/layers";
import BaseEntity from "../../core/entity/BaseEntity";
import { GameSprite } from "../../core/entity/GameSprite";
import { Wind } from "../Wind";
import { WindVisualizationMode } from "./WindVisualizationMode";
import { WorldSpaceWindVisualization } from "./WorldSpaceWindVisualization";

// Visualization modes: 0=off, 1=screen triangles, 2=world triangles, 3=screen streamlines, 4=world streamlines
type VisualizationModeIndex = 0 | 1 | 2 | 3 | 4;

// Dim overlay
const DIM_COLOR = 0x000000;
const DIM_ALPHA = 0.4;

const MODIFIER_FILL_STYLE = {
  color: 0xffaa44,
  alpha: 0.15,
};

export class WindVisualization extends BaseEntity {
  sprite: GameSprite;
  private dimSprite: Sprite;
  private modifierGraphics: Graphics;
  private modeContainer: Container;
  private modeIndex: VisualizationModeIndex = 0;

  private modes: (WindVisualizationMode | null)[] = [
    null, // Mode 0 = off
    // new ScreenSpaceWindVisualization(), // Mode 1 = screen triangles
    new WorldSpaceWindVisualization(), // Mode 2 = world triangles
    // new ScreenSpaceStreamlineVisualization(), // Mode 3 = screen streamlines
    // new WorldSpaceStreamlineVisualization(), // Mode 4 = world streamlines
  ];

  constructor() {
    super();
    const container = new Container() as Container & GameSprite;
    container.layerName = "windViz";

    // Create a 1x1 white texture for the dim overlay
    this.dimSprite = new Sprite(Texture.WHITE);
    this.dimSprite.tint = DIM_COLOR;
    this.dimSprite.alpha = DIM_ALPHA;

    this.modifierGraphics = new Graphics();
    this.modeContainer = new Container();

    container.addChild(this.dimSprite);
    container.addChild(this.modifierGraphics);
    container.addChild(this.modeContainer);

    this.sprite = container;
  }

  onKeyDown({ key }: { key: string }): void {
    if (key === "KeyV") {
      this.toggle();
    }
  }

  private toggle(): void {
    // Hide current mode's visuals
    const currentMode = this.modes[this.modeIndex];
    currentMode?.hide();

    this.modeIndex = ((this.modeIndex + 1) %
      this.modes.length) as VisualizationModeIndex;
    LAYERS.windViz.container.alpha = this.modeIndex > 0 ? 1 : 0;
  }

  private getWind(): Wind | undefined {
    return this.game?.entities.getById("wind") as Wind | undefined;
  }

  onRender(): void {
    this.modifierGraphics.clear();

    const mode = this.modes[this.modeIndex];
    if (!mode) {
      return;
    }

    const wind = this.getWind();
    if (!wind) return;

    const camera = this.game!.camera;
    const viewport = camera.getWorldViewport();

    // Position and scale dim sprite to cover viewport
    this.dimSprite.position.set(viewport.left, viewport.top);
    this.dimSprite.width = viewport.right - viewport.left;
    this.dimSprite.height = viewport.bottom - viewport.top;

    // Draw modifier circles
    this.drawModifierCircles(wind);

    // Delegate to active mode
    const renderer = this.game!.renderer.app.renderer;
    mode.draw(wind, viewport, camera, this.modeContainer, renderer);
  }

  private drawModifierCircles(wind: Wind): void {
    for (const modifier of wind.getModifiers()) {
      const aabb = modifier.getWindModifierAABB();

      this.modifierGraphics
        .rect(
          aabb.minX,
          aabb.minY,
          aabb.maxX - aabb.minX,
          aabb.maxY - aabb.minY
        )
        .fill(MODIFIER_FILL_STYLE);
    }
  }
}
