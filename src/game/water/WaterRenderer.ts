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

  onRender({ draw }: { draw: import("../../core/graphics/Draw").Draw }) {
    if (!this.game) return;

    this.ensureInitialized();
    if (!this.waterShader) return;

    const camera = this.game.camera;
    const renderer = draw.renderer;
    const worldViewport = camera.getWorldViewport();

    // Expand viewport bounds with margin so we have valid data beyond screen edges.
    // This prevents edge artifacts from texture clamping.
    const margin = 0.1; // 10% margin on each side
    const marginX = worldViewport.width * margin;
    const marginY = worldViewport.height * margin;
    const expandedViewport = {
      left: worldViewport.left - marginX,
      top: worldViewport.top - marginY,
      width: worldViewport.width + marginX * 2,
      height: worldViewport.height + marginY * 2,
    };

    // Update data texture with current water state (using expanded viewport)
    const waterInfo = this.game.entities.getById("waterInfo") as
      | WaterInfo
      | undefined;
    if (waterInfo) {
      this.waterDataTexture.update(expandedViewport, waterInfo);
    }

    // Update shader uniforms (using same expanded viewport so UVs map correctly)
    this.waterShader.setTime(this.game.elapsedTime);
    this.waterShader.setScreenSize(renderer.getWidth(), renderer.getHeight());
    this.waterShader.setViewportBounds(
      expandedViewport.left,
      expandedViewport.top,
      expandedViewport.width,
      expandedViewport.height,
    );

    // Get inverse camera matrix for screen-to-world transform
    const cameraMatrix = camera.getMatrix().clone().invert();
    this.waterShader.setCameraMatrix(cameraMatrix.toArray());

    // Render water as fullscreen quad
    this.waterShader.renderWater(this.waterDataTexture.getGLTexture());
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
