import { Filter, Graphics } from "pixi.js";
import BaseEntity from "../../core/entity/BaseEntity";
import { createGraphics, GameSprite } from "../../core/entity/GameSprite";
import { WaterDataTexture } from "./WaterDataTexture";
import { WaterInfo } from "./WaterInfo";
import { createWaterShader } from "./WaterShader";

/**
 * Water rendering entity.
 * Renders an infinite ocean using a custom shader.
 * The shader computes world-space coordinates from screen position + camera,
 * so the water pattern stays fixed in world space as the camera moves.
 *
 * Uses a data texture to pass physics data (height, velocity) to the shader.
 */
export class WaterRenderer extends BaseEntity {
  id = "waterRenderer";
  private waterShader: Filter;
  private graphics: Graphics & GameSprite;
  private waterDataTexture: WaterDataTexture;

  constructor() {
    super();

    // Create data texture first (needed for shader)
    this.waterDataTexture = new WaterDataTexture();

    // Create a screen-sized quad. We position it to follow the camera each frame.
    // The shader handles converting screen coords to world coords.
    this.graphics = createGraphics("water");
    this.graphics.rect(0, 0, 1, 1).fill({ color: 0x0000ff });
    this.graphics.position.set(0, 0);

    // Create shader with data texture bound
    this.waterShader = createWaterShader(this.waterDataTexture.getTexture());
    this.graphics.filters = [this.waterShader];

    this.sprite = this.graphics;
  }

  onRender(dt: number) {
    if (!this.game) return;

    const camera = this.game.camera;
    const worldViewport = camera.getWorldViewport();

    // Update data texture with current water state
    const waterInfo = this.game.entities.getById("waterInfo") as
      | WaterInfo
      | undefined;
    if (waterInfo && this.waterDataTexture) {
      this.waterDataTexture.update(worldViewport, waterInfo);
    }

    // Make sure the graphics object is covering exactly the viewport
    this.graphics.position.set(worldViewport.left, worldViewport.top);
    this.graphics.setSize(worldViewport.width, worldViewport.height);

    const resolution =
      typeof this.waterShader.resolution === "number"
        ? this.waterShader.resolution
        : this.game.renderer.app.renderer.resolution;

    // Update shader uniforms
    this.waterShader.resources.waterUniforms.uniforms.uTime =
      this.game.elapsedTime;
    this.waterShader.resources.waterUniforms.uniforms.uResolution = resolution;

    // Update viewport bounds for data texture UV mapping
    const bounds =
      this.waterShader.resources.waterUniforms.uniforms.uViewportBounds;
    bounds[0] = worldViewport.left;
    bounds[1] = worldViewport.top;
    bounds[2] = worldViewport.width;
    bounds[3] = worldViewport.height;

    camera
      .getMatrix()
      .scale(resolution, resolution)
      .invert()
      .toArray(
        true,
        this.waterShader.resources.waterUniforms.uniforms.uCameraMatrix
      );
  }
}
