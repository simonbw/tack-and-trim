import BaseEntity from "../../core/entity/BaseEntity";
import { WaterDataTexture } from "./WaterDataTexture";
import { WaterInfo } from "./WaterInfo";
import { WaterShader } from "./WaterShader";

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
  layer = "water" as const;

  private waterShader: WaterShader | null = null;
  private waterDataTexture: WaterDataTexture;
  private renderMode = 0;
  private initialized = false;

  constructor() {
    super();
    this.waterDataTexture = new WaterDataTexture();
  }

  private ensureInitialized(): void {
    if (this.initialized || !this.game) return;

    const gl = this.game.getRenderer().getGL();
    this.waterDataTexture.initGL(gl);
    this.waterShader = new WaterShader(gl);
    this.initialized = true;
  }

  onRender() {
    if (!this.game) return;

    this.ensureInitialized();
    if (!this.waterShader) return;

    const camera = this.game.camera;
    const renderer = this.game.getRenderer();
    const worldViewport = camera.getWorldViewport();

    // Update data texture with current water state
    const waterInfo = this.game.entities.getById("waterInfo") as
      | WaterInfo
      | undefined;
    if (waterInfo) {
      this.waterDataTexture.update(worldViewport, waterInfo);
    }

    // Update shader uniforms
    this.waterShader.setTime(this.game.elapsedTime);
    this.waterShader.setScreenSize(renderer.getWidth(), renderer.getHeight());
    this.waterShader.setViewportBounds(
      worldViewport.left,
      worldViewport.top,
      worldViewport.width,
      worldViewport.height
    );

    // Get inverse camera matrix for screen-to-world transform
    const cameraMatrix = camera.getMatrix().clone().invert();
    this.waterShader.setCameraMatrix(cameraMatrix.toArray());

    // Render water as fullscreen quad
    this.waterShader.render(this.waterDataTexture.getGLTexture());
  }

  setRenderMode(mode: number) {
    this.renderMode = mode;
    if (this.waterShader) {
      this.waterShader.setRenderMode(mode);
    }
  }

  onKeyDown({ key }: { key: string }) {
    if (key === "KeyB") {
      this.setRenderMode((this.renderMode + 1) % 2);
    }
  }

  onDestroy() {
    this.waterDataTexture.destroy();
    if (this.waterShader) {
      this.waterShader.destroy();
    }
  }
}
