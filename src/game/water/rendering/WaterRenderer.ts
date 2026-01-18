/**
 * Water rendering entity.
 *
 * Renders an infinite ocean using WebGPU compute and render shaders.
 * Uses WaterRenderPipeline for unified wave/modifier computation,
 * TerrainRenderPipeline for terrain height computation,
 * and WaterShader for combined rendering with depth-based sand/water blending.
 *
 * Note: Physics tile computation is handled by WaterInfo/TerrainInfo, not here.
 * This entity is purely for rendering.
 */

import BaseEntity from "../../../core/entity/BaseEntity";
import { on } from "../../../core/entity/handler";
import { TerrainInfo } from "../../terrain/TerrainInfo";
import { TerrainRenderPipeline } from "../../terrain/rendering/TerrainRenderPipeline";
import { WaterInfo, type Viewport } from "../WaterInfo";
import { WaterRenderPipeline } from "./WaterRenderPipeline";
import { WaterShader } from "./WaterShader";

// Margin for render viewport expansion
const RENDER_VIEWPORT_MARGIN = 0.1;

/**
 * Water renderer entity.
 * Handles only rendering - physics tiles are managed by WaterInfo/TerrainInfo.
 */
export class WaterRenderer extends BaseEntity {
  id = "waterRenderer";
  layer = "water" as const;

  private waterShader: WaterShader | null = null;
  private renderPipeline: WaterRenderPipeline;
  private terrainPipeline: TerrainRenderPipeline;
  private renderMode = 0;
  private initialized = false;

  constructor() {
    super();
    this.renderPipeline = new WaterRenderPipeline();
    this.terrainPipeline = new TerrainRenderPipeline();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized || !this.game) return;

    try {
      await this.renderPipeline.init();
      await this.terrainPipeline.init();

      this.waterShader = new WaterShader();
      await this.waterShader.init();
      this.initialized = true;
    } catch (error) {
      console.error("Failed to initialize WaterRenderer:", error);
    }
  }

  @on("add")
  onAdd() {
    this.ensureInitialized();
  }

  /**
   * Get viewport expanded by the given margin factor.
   */
  private getExpandedViewport(margin: number): Viewport {
    const camera = this.game!.camera;
    const worldViewport = camera.getWorldViewport();

    const marginX = worldViewport.width * margin;
    const marginY = worldViewport.height * margin;

    return {
      left: worldViewport.left - marginX,
      top: worldViewport.top - marginY,
      width: worldViewport.width + marginX * 2,
      height: worldViewport.height + marginY * 2,
    };
  }

  @on("render")
  onRender() {
    if (!this.game || !this.initialized || !this.waterShader) return;

    const camera = this.game.camera;
    const renderer = this.game.getRenderer();
    const expandedViewport = this.getExpandedViewport(RENDER_VIEWPORT_MARGIN);
    const gpuProfiler = this.game.renderer.getGpuProfiler();
    const currentTime = this.game.elapsedUnpausedTime;

    // Update water render pipeline (runs unified GPU compute)
    const waterInfo = WaterInfo.fromGame(this.game);
    this.renderPipeline.update(expandedViewport, waterInfo, gpuProfiler);

    // Update terrain render pipeline if terrain exists
    const terrainInfo = TerrainInfo.maybeFromGame(this.game);
    let terrainTextureView: GPUTextureView | null = null;

    if (terrainInfo) {
      // Sync terrain definition with render pipeline
      const landMasses = terrainInfo.getLandMasses();
      if (landMasses.length > 0) {
        this.terrainPipeline.setTerrainDefinition({ landMasses: [...landMasses] });
      }

      // Update terrain compute
      this.terrainPipeline.update(
        {
          left: expandedViewport.left,
          top: expandedViewport.top,
          width: expandedViewport.width,
          height: expandedViewport.height,
        },
        currentTime,
        gpuProfiler,
        "terrainCompute"
      );

      // Get terrain texture if we have terrain data
      if (this.terrainPipeline.hasTerrainData()) {
        terrainTextureView = this.terrainPipeline.getOutputTextureView();
      }
    }

    // Get water texture view
    const waterTextureView = this.renderPipeline.getOutputTextureView();
    if (!waterTextureView) return;

    // Update shader uniforms
    this.waterShader.setTime(this.game.elapsedTime);
    this.waterShader.setScreenSize(renderer.getWidth(), renderer.getHeight());
    this.waterShader.setViewportBounds(
      expandedViewport.left,
      expandedViewport.top,
      expandedViewport.width,
      expandedViewport.height
    );
    this.waterShader.setRenderMode(this.renderMode);

    // Get inverse camera matrix for screen-to-world transform
    const cameraMatrix = camera.getMatrix().clone().invert();
    this.waterShader.setCameraMatrix(cameraMatrix.toArray());

    // Use the main renderer's render pass
    const renderPass = renderer.getCurrentRenderPass();
    if (!renderPass) return;

    // Render water with optional terrain to the main render pass
    this.waterShader.render(renderPass, waterTextureView, terrainTextureView);
  }

  setRenderMode(mode: number): void {
    this.renderMode = mode;
  }

  @on("keyDown")
  onKeyDown({ key }: { key: string }): void {
    if (key === "KeyB") {
      this.setRenderMode((this.renderMode + 1) % 2);
    }
  }

  @on("destroy")
  onDestroy(): void {
    this.renderPipeline.destroy();
    this.terrainPipeline.destroy();
    this.waterShader?.destroy();
  }
}
