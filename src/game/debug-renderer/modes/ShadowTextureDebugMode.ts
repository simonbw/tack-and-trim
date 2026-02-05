/**
 * Shadow Texture Debug Mode
 *
 * Visualizes the ACTUAL shadow texture being passed to the water shader.
 * This shows what the GPU has pre-computed, unlike WaveEnergyDebugMode
 * which computes diffraction on the CPU.
 *
 * Press [ or ] to toggle between swell (R channel) and chop (G channel).
 */

import type { GameEventMap } from "../../../core/entity/Entity";
import { on } from "../../../core/entity/handler";
import { WavePhysicsResources } from "../../wave-physics/WavePhysicsResources";
import { DebugRenderMode } from "./DebugRenderMode";

// Visualization colors
const DIM_COLOR = 0x000000;
const DIM_ALPHA = 0.6;
const GRID_SIZE = 128; // Higher resolution for texture sampling

export class ShadowTextureDebugMode extends DebugRenderMode {
  layer = "windViz" as const;
  private showSwell = true; // true = swell (R), false = chop (G)
  private textureData: Float32Array | null = null;
  private textureWidth = 0;
  private textureHeight = 0;
  private dataReady = false;

  @on("render")
  onRender({ draw }: GameEventMap["render"]): void {
    const wavePhysicsResources =
      this.game.entities.tryGetSingleton(WavePhysicsResources);
    const wavePhysicsManager = wavePhysicsResources?.getWavePhysicsManager();

    if (!wavePhysicsManager || !wavePhysicsManager.isInitialized()) {
      return;
    }

    const viewport = this.game.camera.getWorldViewport();

    // Draw dim overlay
    draw.fillRect(
      viewport.left,
      viewport.top,
      viewport.width,
      viewport.height,
      {
        color: DIM_COLOR,
        alpha: DIM_ALPHA,
      },
    );

    // Get the shadow texture view (this is what the water shader uses!)
    const shadowTextureView = wavePhysicsManager.getShadowTextureView();
    if (!shadowTextureView) {
      draw.fillRect(
        viewport.left + viewport.width / 2 - 200,
        viewport.top + viewport.height / 2,
        400,
        50,
        {
          color: 0xff0000,
          alpha: 0.8,
        },
      );
      return;
    }

    // Note: Texture readback not implemented yet
    // For now, just show that the texture exists
    if (!this.dataReady) {
      return;
    }

    // Sample the texture data on a grid and render as colored rectangles
    const cellWidth = viewport.width / GRID_SIZE;
    const cellHeight = viewport.height / GRID_SIZE;

    for (let gy = 0; gy < GRID_SIZE; gy++) {
      for (let gx = 0; gx < GRID_SIZE; gx++) {
        const worldX = viewport.left + (gx + 0.5) * cellWidth;
        const worldY = viewport.top + (gy + 0.5) * cellHeight;

        // Sample texture at this world position
        const attenuation = this.sampleTexture(worldX, worldY, viewport);

        // Pick channel based on mode
        const value = this.showSwell ? attenuation[0] : attenuation[1];

        // Map attenuation to color (0.0=red, 0.5=yellow, 1.0=green)
        const color = this.attenuationToColor(value);
        const alpha = 0.7;

        // Draw cell
        const rectX = viewport.left + gx * cellWidth;
        const rectY = viewport.top + gy * cellHeight;
        draw.fillRect(rectX, rectY, cellWidth, cellHeight, {
          color,
          alpha,
        });
      }
    }
  }

  /**
   * Sample the texture at a world position.
   * Returns [swellAttenuation, chopAttenuation].
   */
  private sampleTexture(
    worldX: number,
    worldY: number,
    viewport: { left: number; top: number; width: number; height: number },
  ): [number, number] {
    if (!this.dataReady || !this.textureData) {
      return [1.0, 1.0]; // Full energy (no shadow)
    }

    // Convert world position to texture UV
    const u = (worldX - viewport.left) / viewport.width;
    const v = (worldY - viewport.top) / viewport.height;

    // Clamp to [0, 1]
    const clampedU = Math.max(0, Math.min(1, u));
    const clampedV = Math.max(0, Math.min(1, v));

    // Convert to texel coordinates
    const texelX = Math.floor(clampedU * this.textureWidth);
    const texelY = Math.floor(clampedV * this.textureHeight);

    // Read from texture data (rg16float format, 2 values per pixel)
    const index = (texelY * this.textureWidth + texelX) * 2;
    const swellAttenuation = this.textureData[index + 0];
    const chopAttenuation = this.textureData[index + 1];

    return [swellAttenuation, chopAttenuation];
  }

  private attenuationToColor(attenuation: number): number {
    // Red (0.0) -> Yellow (0.5) -> Green (1.0)
    if (attenuation < 0.5) {
      const t = attenuation * 2;
      const r = 255;
      const g = Math.floor(t * 255);
      const b = 0;
      return (r << 16) | (g << 8) | b;
    } else {
      const t = (attenuation - 0.5) * 2;
      const r = Math.floor((1 - t) * 255);
      const g = 255;
      const b = 0;
      return (r << 16) | (g << 8) | b;
    }
  }

  @on("keyDown")
  onKeyDown({ key }: GameEventMap["keyDown"]): void {
    if (key === "BracketLeft" || key === "BracketRight") {
      // Toggle between swell and chop
      this.showSwell = !this.showSwell;
    }
  }

  getModeName(): string {
    return "Shadow Texture (GPU)";
  }

  getHudInfo(): string | null {
    const type = this.showSwell ? "Swell (R)" : "Chop (G)";
    const status = this.dataReady ? "" : "\n(Texture readback not implemented)";
    return `${type}: Actual GPU shadow texture${status}\nRed=shadow, Yellow=partial, Green=full energy`;
  }

  getCursorInfo(): string | null {
    const mouseWorldPos = this.game.camera.toWorld(this.game.io.mousePosition);
    if (!mouseWorldPos) return null;

    const viewport = this.game.camera.getWorldViewport();
    const attenuation = this.sampleTexture(
      mouseWorldPos.x,
      mouseWorldPos.y,
      viewport,
    );
    const value = this.showSwell ? attenuation[0] : attenuation[1];

    const posStr = `(${mouseWorldPos.x.toFixed(0)}, ${mouseWorldPos.y.toFixed(0)})`;
    const attStr = `${(value * 100).toFixed(1)}%`;
    return `${posStr}\nGPU Energy: ${attStr}`;
  }
}
