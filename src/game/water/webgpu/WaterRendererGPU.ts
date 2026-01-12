/**
 * WebGPU-based water rendering entity.
 *
 * Renders an infinite ocean using WebGPU compute and render shaders.
 * Uses WaterComputePipelineGPU for wave computation and WaterShaderGPU for rendering.
 *
 * Lifecycle:
 * - onBeforeTick: Complete tile readbacks from previous frame
 * - onAfterPhysics: Compute tiles for physics queries
 * - onRender: Run wave and modifier compute, render water
 */

import BaseEntity from "../../../core/entity/BaseEntity";
import { TileComputePipeline } from "../tiles/TileComputePipeline";
import { TileManager } from "../tiles/TileManager";
import { DEFAULT_TILE_CONFIG } from "../tiles/TileTypes";
import { WaterInfo } from "../WaterInfo";
import { WaterComputePipelineGPU, Viewport } from "./WaterComputePipelineGPU";
import { WaterShaderGPU } from "./WaterShaderGPU";

/**
 * WebGPU water renderer entity.
 */
// Margin for render viewport expansion
const RENDER_VIEWPORT_MARGIN = 0.1;

export class WaterRendererGPU extends BaseEntity {
  id = "waterRenderer";
  layer = "water" as const;

  private waterShader: WaterShaderGPU | null = null;
  private computePipeline: WaterComputePipelineGPU;
  private renderMode = 0;
  private initialized = false;

  // Tile system for physics queries
  private tileManager: TileManager;
  private tileComputePipeline: TileComputePipeline;
  private tilesConnected = false;

  constructor() {
    super();
    this.computePipeline = new WaterComputePipelineGPU();

    // Initialize tile system
    this.tileManager = new TileManager(DEFAULT_TILE_CONFIG);
    this.tileComputePipeline = new TileComputePipeline(DEFAULT_TILE_CONFIG);
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized || !this.game) return;

    try {
      await this.computePipeline.init();
      await this.tileComputePipeline.init();
      this.waterShader = new WaterShaderGPU();
      await this.waterShader.init();
      this.initialized = true;

      // Connect tile system to WaterInfo
      this.connectTileSystem();
    } catch (error) {
      console.error("Failed to initialize WaterRendererGPU:", error);
    }
  }

  /**
   * Connect the tile system to WaterInfo for physics queries.
   */
  private connectTileSystem(): void {
    if (this.tilesConnected || !this.initialized || !this.game) return;

    WaterInfo.fromGame(this.game).setTileSystem(
      this.tileManager,
      this.tileComputePipeline.getReadbackPool(),
    );
    this.tilesConnected = true;
  }

  onAdd() {
    // Kick off async initialization
    this.ensureInitialized();
  }

  /**
   * Complete tile readbacks from previous frame.
   * Called at start of tick to make last frame's GPU data available for physics.
   */
  onBeforeTick() {
    if (!this.initialized) return;

    // Ensure tiles are connected (in case WaterInfo was added after us)
    if (!this.tilesConnected) {
      this.connectTileSystem();
    }

    // Complete tile readbacks from previous frame
    this.tileComputePipeline.completeReadbacks().catch((error) => {
      console.warn("Tile readback completion error:", error);
    });
  }

  /**
   * Compute tiles for physics queries.
   * Called after physics step so the computed data will be ready for next frame.
   */
  onAfterPhysics() {
    if (!this.initialized || !this.game) return;

    const time = this.game.elapsedUnpausedTime;
    const gpuProfiler = this.game.renderer.getGpuProfiler();

    // Get WaterInfo for query forecast collection
    const waterInfo = WaterInfo.fromGame(this.game);

    // Collect query forecasts from all WaterQueriers
    waterInfo.collectQueryForecasts();

    // Select tiles to compute
    const tilesToCompute = this.tileManager.selectTilesToCompute(time);

    // Compute selected tiles
    if (tilesToCompute.length > 0) {
      this.tileComputePipeline.computeTiles(
        tilesToCompute,
        time,
        waterInfo,
        gpuProfiler,
      );
    }
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

  onRender() {
    if (!this.game || !this.initialized || !this.waterShader) return;

    const camera = this.game.camera;
    const renderer = this.game.getRenderer();
    const expandedViewport = this.getExpandedViewport(RENDER_VIEWPORT_MARGIN);
    const gpuProfiler = this.game.renderer.getGpuProfiler();

    // Update compute pipeline (runs GPU compute for rendering + updates modifier texture)
    const waterInfo = WaterInfo.fromGame(this.game);
    this.computePipeline.update(expandedViewport, waterInfo, gpuProfiler);

    // Get texture views
    const waveTextureView = this.computePipeline.getWaveTextureView();
    const modifierTextureView = this.computePipeline.getModifierTextureView();

    if (!waveTextureView || !modifierTextureView) return;

    // Update shader uniforms
    this.waterShader.setTime(this.game.elapsedTime);
    this.waterShader.setScreenSize(renderer.getWidth(), renderer.getHeight());
    this.waterShader.setViewportBounds(
      expandedViewport.left,
      expandedViewport.top,
      expandedViewport.width,
      expandedViewport.height,
    );
    this.waterShader.setRenderMode(this.renderMode);

    // Get inverse camera matrix for screen-to-world transform
    const cameraMatrix = camera.getMatrix().clone().invert();
    this.waterShader.setCameraMatrix(cameraMatrix.toArray());

    // Use the main renderer's render pass
    const renderPass = renderer.getCurrentRenderPass();
    if (!renderPass) return;

    // Render water to the main render pass
    this.waterShader.render(renderPass, waveTextureView, modifierTextureView);
  }

  setRenderMode(mode: number): void {
    this.renderMode = mode;
  }

  onKeyDown({ key }: { key: string }): void {
    if (key === "KeyB") {
      this.setRenderMode((this.renderMode + 1) % 2);
    }
  }

  onDestroy(): void {
    this.computePipeline.destroy();
    this.tileComputePipeline.destroy();
    this.waterShader?.destroy();
  }
}
