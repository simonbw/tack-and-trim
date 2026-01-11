/**
 * WebGPU-based water rendering entity.
 *
 * Renders an infinite ocean using WebGPU compute and render shaders.
 * Uses WaterComputePipelineGPU for wave computation and WaterShaderGPU for rendering.
 *
 * Lifecycle:
 * - onBeforeTick: Complete async readback from previous frame
 * - onAfterPhysics: Kick off GPU compute and initiate readback for next frame
 * - onRender: Update modifier texture and render water
 */

import BaseEntity from "../../../core/entity/BaseEntity";
import type { WaterInfo } from "../WaterInfo";
import { WaterComputePipelineGPU, Viewport } from "./WaterComputePipelineGPU";
import { WaterShaderGPU } from "./WaterShaderGPU";

/**
 * WebGPU water renderer entity.
 */
// Margin for physics viewport expansion (larger than render margin)
const PHYSICS_VIEWPORT_MARGIN = 0.25;
// Margin for render viewport expansion
const RENDER_VIEWPORT_MARGIN = 0.1;

export class WaterRendererGPU extends BaseEntity {
  id = "waterRenderer";
  layer = "water" as const;

  private waterShader: WaterShaderGPU | null = null;
  private computePipeline: WaterComputePipelineGPU;
  private renderMode = 0;
  private initialized = false;

  // Track if we need to connect the readback buffer to WaterInfo
  private readbackConnected = false;

  constructor() {
    super();
    this.computePipeline = new WaterComputePipelineGPU();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized || !this.game) return;

    try {
      await this.computePipeline.init();
      this.waterShader = new WaterShaderGPU();
      await this.waterShader.init();
      this.initialized = true;

      // Connect readback buffer to WaterInfo
      this.connectReadbackBuffer();
    } catch (error) {
      console.error("Failed to initialize WaterRendererGPU:", error);
    }
  }

  /**
   * Connect the readback buffer to WaterInfo for physics queries.
   */
  private connectReadbackBuffer(): void {
    if (this.readbackConnected || !this.initialized) return;

    const waterInfo = this.game?.entities.getById("waterInfo") as
      | WaterInfo
      | undefined;
    if (waterInfo) {
      waterInfo.setReadbackBuffer(this.computePipeline.getReadbackBuffer());
      this.readbackConnected = true;
    }
  }

  onAdd() {
    // Kick off async initialization
    this.ensureInitialized();
  }

  /**
   * Complete readback from previous frame.
   * Called at start of tick to make last frame's GPU data available for physics.
   */
  onBeforeTick() {
    if (!this.initialized) return;

    // Ensure readback buffer is connected (in case WaterInfo was added after us)
    if (!this.readbackConnected) {
      this.connectReadbackBuffer();
    }

    // Complete async readback from previous frame
    // Note: This is fire-and-forget since we can't await in event handlers
    // The readback should already be complete by now in most cases
    this.computePipeline.completeReadback().catch((error) => {
      console.warn("Water readback completion error:", error);
    });
  }

  /**
   * Kick off GPU compute and initiate readback for next frame's physics.
   * Called after physics step so the computed data will be ready for next frame.
   */
  onAfterPhysics() {
    if (!this.initialized || !this.game) return;

    const viewport = this.getExpandedViewport(PHYSICS_VIEWPORT_MARGIN);
    const time = this.game.elapsedUnpausedTime;
    const gpuProfiler = this.game.renderer.getGpuProfiler();

    // Run GPU compute and initiate async readback
    this.computePipeline.computeAndInitiateReadback(
      viewport,
      time,
      gpuProfiler,
    );
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
    const waterInfo = this.game.entities.getById("waterInfo") as
      | WaterInfo
      | undefined;
    if (waterInfo) {
      this.computePipeline.update(expandedViewport, waterInfo, gpuProfiler);
    }

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
    this.waterShader?.destroy();
  }
}
