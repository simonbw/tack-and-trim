/**
 * WebGPU-based water rendering entity.
 *
 * Renders an infinite ocean using WebGPU compute and render shaders.
 * Uses WaterComputePipelineGPU for wave computation and WaterShaderGPU for rendering.
 */

import BaseEntity from "../../../core/entity/BaseEntity";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import type { WaterInfo } from "../WaterInfo";
import { WaterComputePipelineGPU } from "./WaterComputePipelineGPU";
import { WaterShaderGPU } from "./WaterShaderGPU";

/**
 * WebGPU water renderer entity.
 */
export class WaterRendererGPU extends BaseEntity {
  id = "waterRenderer";
  layer = "water" as const;

  private waterShader: WaterShaderGPU | null = null;
  private computePipeline: WaterComputePipelineGPU;
  private renderMode = 0;
  private initialized = false;

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
    } catch (error) {
      console.error("Failed to initialize WaterRendererGPU:", error);
    }
  }

  onAdd() {
    // Kick off async initialization
    this.ensureInitialized();
  }

  onRender() {
    if (!this.game || !this.initialized || !this.waterShader) return;

    const camera = this.game.camera;
    const worldViewport = camera.getWorldViewport();
    const renderer = this.game.getRenderer();

    // Expand viewport bounds with margin
    const margin = 0.1;
    const marginX = worldViewport.width * margin;
    const marginY = worldViewport.height * margin;
    const expandedViewport = {
      left: worldViewport.left - marginX,
      top: worldViewport.top - marginY,
      width: worldViewport.width + marginX * 2,
      height: worldViewport.height + marginY * 2,
    };

    // Update compute pipeline
    const waterInfo = this.game.entities.getById("waterInfo") as
      | WaterInfo
      | undefined;
    if (waterInfo) {
      this.computePipeline.update(expandedViewport, waterInfo);
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
      expandedViewport.height
    );
    this.waterShader.setRenderMode(this.renderMode);

    // Get inverse camera matrix for screen-to-world transform
    const cameraMatrix = camera.getMatrix().clone().invert();
    this.waterShader.setCameraMatrix(cameraMatrix.toArray());

    // Create command encoder for water rendering
    const device = getWebGPU().device;
    const commandEncoder = device.createCommandEncoder({
      label: "Water Render Command Encoder",
    });

    // Get canvas texture view for rendering
    // Note: In a full integration, this would use the main render pass
    // For now, we create a separate pass
    const canvas = renderer.canvas as HTMLCanvasElement;
    const context = canvas.getContext("webgpu");
    if (!context) return;

    const canvasTexture = context.getCurrentTexture();
    const canvasView = canvasTexture.createView();

    // Begin render pass
    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: canvasView,
          loadOp: "load", // Preserve previous content
          storeOp: "store",
        },
      ],
      label: "Water Render Pass",
    });

    // Render water
    this.waterShader.render(renderPass, waveTextureView, modifierTextureView);

    renderPass.end();

    // Submit
    device.queue.submit([commandEncoder.finish()]);
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
