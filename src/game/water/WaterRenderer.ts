import BaseEntity from "../../core/entity/BaseEntity";
import { WaterComputePipeline } from "./WaterComputePipeline";
import { WaterInfo } from "./WaterInfo";
import { WaterShader } from "./WaterShader";

/**
 * Water Rendering System
 *
 * GPU Pipeline (managed by WaterComputePipeline):
 *   - WaveComputeShader: Gerstner wave computation (GPU)
 *   - WaveTexture: Output framebuffer for wave data
 *   - ModifierDataTexture: Wake/splash contributions (CPU → GPU)
 *
 * Rendering:
 *   - WaterShader: Samples textures and renders water surface
 *   - WaterConstants: Shared configuration values
 *
 * Physics (separate path, uses CPU):
 *   - WaterInfo: Provides getStateAtPoint() for physics queries
 *   - WaterModifier: Interface for entities affecting water (Wake, WakeParticle)
 */

/**
 * Water rendering entity.
 * Renders an infinite ocean using a custom shader.
 * The shader computes world-space coordinates from screen position + camera,
 * so the water pattern stays fixed in world space as the camera moves.
 */
export class WaterRenderer extends BaseEntity {
  id = "waterRenderer";
  layer = "water" as const;

  private waterShader: WaterShader | null = null;
  private computePipeline: WaterComputePipeline;
  private renderMode = 0;
  private initialized = false;

  constructor() {
    super();
    this.computePipeline = new WaterComputePipeline();
  }

  private ensureInitialized(): void {
    if (this.initialized || !this.game) return;

    const gl = this.game.getRenderer().getGL();
    this.computePipeline.initGL(gl);
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

    // Update compute pipeline with current water state (using expanded viewport)
    const waterInfo = this.game.entities.getById("waterInfo") as
      | WaterInfo
      | undefined;
    if (waterInfo) {
      this.computePipeline.update(expandedViewport, waterInfo);
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
    this.waterShader.renderWater(
      this.computePipeline.getWaveTexture(),
      this.computePipeline.getModifierTexture(),
    );
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
    this.computePipeline.destroy();
    if (this.waterShader) {
      this.waterShader.destroy();
    }
  }
}
