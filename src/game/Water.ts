import BaseEntity from "../core/entity/BaseEntity";
import { createGraphics } from "../core/entity/GameSprite";
import { WaterShader } from "./water/WaterShader";

/**
 * Water entity that renders an infinite ocean using a custom shader.
 * The shader computes world-space coordinates from screen position + camera,
 * so the water pattern stays fixed in world space as the camera moves.
 */
export class Water extends BaseEntity {
  private waterShader: WaterShader;

  constructor() {
    super();

    // Create a screen-sized quad. We position it to follow the camera each frame.
    // The shader handles converting screen coords to world coords.
    const graphics = createGraphics("water");

    this.waterShader = new WaterShader();
    graphics.filters = [this.waterShader];

    this.sprite = graphics;
  }

  onRender(dt: number) {
    if (!this.game) return;

    const camera = this.game.camera;
    const width = this.game.renderer.getWidth();
    const height = this.game.renderer.getHeight();

    // Rebuild the quad to match screen size, positioned to always be in view.
    // We position it at the camera location and scale it to cover the viewport.
    const sprite = this.sprite!;
    sprite.clear();
    const halfWidth = width / camera.z / 2;
    const halfHeight = height / camera.z / 2;
    sprite
      .rect(
        camera.x - halfWidth,
        camera.y - halfHeight,
        width / camera.z,
        height / camera.z
      )
      .fill({ color: 0x1a4a6e });

    // Update shader uniforms
    this.waterShader.time = this.game.elapsedTime;
    this.waterShader.cameraPosition = [camera.x, camera.y];
    this.waterShader.cameraZoom = camera.z;
    this.waterShader.resolution = [width, height];
  }
}
