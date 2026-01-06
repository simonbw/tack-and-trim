import BaseEntity from "../core/entity/BaseEntity";
import { createGraphics } from "../core/entity/GameSprite";
import { WaterShader } from "./water/WaterShader";

/**
 * Water entity that renders an infinite ocean using a custom shader.
 * The water pattern is in world-space, so it stays fixed as the camera moves.
 */
export class Water extends BaseEntity {
  private waterShader: WaterShader;

  constructor() {
    super();

    // Create a full-screen quad that we'll apply the shader to.
    // We make it very large to ensure it always covers the viewport at any zoom level.
    const graphics = createGraphics("water");
    graphics.rect(-50000, -50000, 100000, 100000).fill({ color: 0x1a4a6e });

    this.waterShader = new WaterShader();
    graphics.filters = [this.waterShader];

    this.sprite = graphics;
  }

  onRender(dt: number) {
    if (!this.game) return;

    const camera = this.game.camera;

    // Update shader uniforms
    this.waterShader.time = this.game.elapsedTime;
    this.waterShader.cameraPosition = [camera.x, camera.y];
    this.waterShader.cameraZoom = camera.z;
    this.waterShader.resolution = [
      this.game.renderer.getWidth(),
      this.game.renderer.getHeight(),
    ];
  }
}
