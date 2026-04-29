import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import { Light } from "./Light";
import { LightsRasterizer } from "./LightsRasterizer";

/**
 * Singleton entity that drives the screen-space lights texture.
 *
 * Each frame, before any layer's draws are flushed, this entity collects
 * every Light entity in the game and rasterizes them into the renderer's
 * lightsTexture. The shape shader fragment stage then samples that texture
 * and adds the contribution to the global ambientLight term.
 */
export class LightingSystem extends BaseEntity {
  // Run during the first layer pass so the lights texture is updated
  // before the shape batch flushes at endFrame.
  layer = "boat" as const;

  private rasterizer: LightsRasterizer | null = null;
  private initPromise: Promise<void> | null = null;
  private initialized = false;

  @on("add")
  onAdd() {
    this.initPromise = this.ensureInitialized();
  }

  whenReady(): Promise<void> {
    return this.initPromise ?? Promise.resolve();
  }

  private async ensureInitialized(): Promise<void> {
    const device = this.game.getWebGPUDevice();
    this.rasterizer = new LightsRasterizer(device);
    await this.rasterizer.init();
    this.initialized = true;
  }

  @on("render")
  onRender() {
    if (!this.initialized || !this.rasterizer) return;
    const renderer = this.game.getRenderer();
    const lightsView = renderer.getLightsTextureView();
    if (!lightsView) return;

    const lights: Light[] = [];
    for (const entity of this.game.entities.getTagged("light")) {
      lights.push(entity as Light);
    }

    const camera = this.game.camera;
    // viewMatrix maps physical pixels → clip; cameraMatrix maps world →
    // physical pixels. Composed: world → clip.
    const worldToClip = renderer
      .getViewMatrix()
      .clone()
      .multiply(camera.getMatrix());

    const device = this.game.getWebGPUDevice();
    const encoder = device.createCommandEncoder({
      label: "Lights Rasterization",
    });
    this.rasterizer.render(
      encoder,
      lights,
      worldToClip,
      lightsView,
      this.game.elapsedUnpausedTime,
    );
    device.queue.submit([encoder.finish()]);
  }

  onDestroy() {
    this.rasterizer?.destroy();
    this.rasterizer = null;
  }
}
