/**
 * Debug visualization entity for influence fields.
 *
 * Uses a GPU fullscreen shader to render influence data efficiently.
 * Much faster than the previous Draw API approach which called fillRect
 * for each grid cell.
 *
 * Keyboard controls:
 * - I: Cycle through modes (Off → Depth → Swell Long → Swell Short → Fetch → Off)
 * - Shift+I: Reset to off
 * - [ / ]: Rotate selected direction ±22.5°
 *
 * Note: Wind influence mode was removed because there's no GPU texture for it.
 * Wind data is only available on the CPU.
 */

import { BaseEntity } from "../../core/entity/BaseEntity";
import type { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import type { Draw } from "../../core/graphics/Draw";
import { getWebGPU } from "../../core/graphics/webgpu/WebGPUDevice";
import { V } from "../../core/Vector";
import { InfluenceFieldManager } from "../world-data/influence/InfluenceFieldManager";
import { InfluenceDebugShader, UNIFORM_SIZE } from "./InfluenceDebugShader";

// HUD styling
const HUD_BG_COLOR = 0x000000;
const HUD_BG_ALPHA = 0.7;
const HUD_MARGIN = 10;
const HUD_PADDING = 8;
const HUD_WIDTH = 180;
const HUD_HEIGHT = 60;

// Direction indicator
const DIRECTION_INDICATOR_RADIUS = 20;
const DIRECTION_INDICATOR_COLOR = 0xffffff;
const DIRECTION_ARROW_COLOR = 0x44aaff;

// Mode definitions
interface ModeDefinition {
  name: string;
  shaderMode: number; // Mode index passed to shader (0 = off)
  usesDirection: boolean;
}

const MODES: ModeDefinition[] = [
  { name: "Off", shaderMode: 0, usesDirection: false },
  { name: "Depth", shaderMode: 1, usesDirection: false },
  { name: "Swell Long", shaderMode: 2, usesDirection: true },
  { name: "Swell Short", shaderMode: 3, usesDirection: true },
  { name: "Fetch", shaderMode: 4, usesDirection: true },
];

export class InfluenceDebugVisualization extends BaseEntity {
  id = "influenceDebugVisualization";
  layer = "windViz" as const;

  private modeIndex = 0;
  private directionIndex = 0;
  private directionCount = 16;

  // GPU resources
  private shader: InfluenceDebugShader | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private uniformData = new Float32Array(UNIFORM_SIZE / 4);
  private bindGroup: GPUBindGroup | null = null;
  private initialized = false;

  // Track texture changes for bind group recreation
  private lastSwellTexture: GPUTexture | null = null;
  private lastFetchTexture: GPUTexture | null = null;
  private lastDepthTexture: GPUTexture | null = null;

  @on("add")
  async onAdd(): Promise<void> {
    await this.initGPU();
  }

  private async initGPU(): Promise<void> {
    if (this.initialized) return;

    try {
      const device = getWebGPU().device;

      // Create shader
      this.shader = new InfluenceDebugShader();
      await this.shader.init();

      // Create uniform buffer
      this.uniformBuffer = device.createBuffer({
        size: UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: "Influence Debug Uniforms",
      });

      this.initialized = true;
    } catch (error) {
      console.error("Failed to initialize InfluenceDebugVisualization:", error);
    }
  }

  @on("keyDown")
  onKeyDown({ key, event }: GameEventMap["keyDown"]): void {
    if (key === "KeyI") {
      if (event.shiftKey) {
        this.modeIndex = 0;
      } else {
        this.modeIndex = (this.modeIndex + 1) % MODES.length;
      }
    } else if (key === "BracketLeft") {
      this.directionIndex =
        (this.directionIndex - 1 + this.directionCount) % this.directionCount;
    } else if (key === "BracketRight") {
      this.directionIndex = (this.directionIndex + 1) % this.directionCount;
    }
  }

  @on("render")
  onRender({ draw }: { draw: Draw }): void {
    const mode = MODES[this.modeIndex];
    if (mode.shaderMode === 0) {
      return; // Mode off
    }

    if (!this.initialized || !this.shader || !this.uniformBuffer) {
      return;
    }

    const manager = InfluenceFieldManager.maybeFromGame(this.game);
    if (!manager || !manager.isInitialized()) {
      return;
    }

    // Update direction count
    const swellGridConfig = manager.getSwellGridConfig();
    if (swellGridConfig) {
      this.directionCount = swellGridConfig.directionCount;
    }

    // Get required textures
    const swellTexture = manager.getSwellTexture();
    const fetchTexture = manager.getFetchTexture();
    const depthTexture = manager.getDepthTexture();
    const sampler = manager.getInfluenceSampler();

    if (!swellTexture || !fetchTexture || !depthTexture || !sampler) {
      return;
    }

    // Recreate bind group if textures changed
    if (
      !this.bindGroup ||
      this.lastSwellTexture !== swellTexture ||
      this.lastFetchTexture !== fetchTexture ||
      this.lastDepthTexture !== depthTexture
    ) {
      this.bindGroup = this.shader.createBindGroup({
        uniforms: { buffer: this.uniformBuffer },
        influenceSampler: sampler,
        swellTexture: swellTexture.createView(),
        fetchTexture: fetchTexture.createView(),
        depthTexture: depthTexture.createView(),
      });
      this.lastSwellTexture = swellTexture;
      this.lastFetchTexture = fetchTexture;
      this.lastDepthTexture = depthTexture;
    }

    // Update uniforms
    const camera = this.game.camera;
    const viewport = camera.getWorldViewport();

    const fetchGridConfig = manager.getFetchGridConfig();
    const depthGridConfig = manager.getDepthGridConfig();

    if (!swellGridConfig || !fetchGridConfig || !depthGridConfig) {
      return;
    }

    // Pack uniforms (see InfluenceDebugShader.ts for layout)
    let offset = 0;

    // viewportBounds: vec4<f32>
    this.uniformData[offset++] = viewport.left;
    this.uniformData[offset++] = viewport.top;
    this.uniformData[offset++] = viewport.right - viewport.left;
    this.uniformData[offset++] = viewport.bottom - viewport.top;

    // swellGridOrigin: vec2<f32>
    this.uniformData[offset++] = swellGridConfig.originX;
    this.uniformData[offset++] = swellGridConfig.originY;
    // swellGridSize: vec2<f32>
    this.uniformData[offset++] =
      swellGridConfig.cellsX * swellGridConfig.cellSize;
    this.uniformData[offset++] =
      swellGridConfig.cellsY * swellGridConfig.cellSize;

    // fetchGridOrigin: vec2<f32>
    this.uniformData[offset++] = fetchGridConfig.originX;
    this.uniformData[offset++] = fetchGridConfig.originY;
    // fetchGridSize: vec2<f32>
    this.uniformData[offset++] =
      fetchGridConfig.cellsX * fetchGridConfig.cellSize;
    this.uniformData[offset++] =
      fetchGridConfig.cellsY * fetchGridConfig.cellSize;

    // depthGridOrigin: vec2<f32>
    this.uniformData[offset++] = depthGridConfig.originX;
    this.uniformData[offset++] = depthGridConfig.originY;
    // depthGridSize: vec2<f32>
    this.uniformData[offset++] =
      depthGridConfig.cellsX * depthGridConfig.cellSize;
    this.uniformData[offset++] =
      depthGridConfig.cellsY * depthGridConfig.cellSize;

    // mode: i32
    const intView = new Int32Array(this.uniformData.buffer);
    intView[offset++] = mode.shaderMode;
    // directionIndex: i32
    intView[offset++] = this.directionIndex;
    // directionCount: i32
    intView[offset++] = this.directionCount;
    // padding: i32
    intView[offset++] = 0;

    // Upload uniforms
    const device = getWebGPU().device;
    device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData.buffer);

    // Render using the main render pass
    const renderer = this.game.getRenderer();
    const renderPass = renderer.getCurrentRenderPass();
    if (!renderPass) {
      return;
    }

    this.shader.render(renderPass, this.bindGroup);

    // Draw HUD (small number of primitives, fine to use Draw API)
    this.drawHUD(draw, mode);
  }

  private drawHUD(draw: Draw, mode: ModeDefinition): void {
    const viewportSize = this.game.camera.getViewportSize();
    const camPos = this.game.camera.getPosition();
    const camZ = this.game.camera.z;

    // Calculate world-space position for HUD (bottom-left corner)
    const halfW = viewportSize.x / (2 * camZ);
    const halfH = viewportSize.y / (2 * camZ);

    const hudX = camPos.x - halfW + HUD_MARGIN / camZ;
    const hudY = camPos.y + halfH - HUD_MARGIN / camZ - HUD_HEIGHT / camZ;
    const hudW = HUD_WIDTH / camZ;
    const hudH = HUD_HEIGHT / camZ;

    // Draw background
    draw.fillRect(hudX, hudY, hudW, hudH, {
      color: HUD_BG_COLOR,
      alpha: HUD_BG_ALPHA,
    });

    // Draw mode indicator bars (one for each visualization mode, excluding "Off")
    const activeModes = MODES.length - 1; // Exclude "Off"
    const modeBarWidth = (hudW - (HUD_PADDING * 2) / camZ) / activeModes;
    const modeBarHeight = 6 / camZ;
    const modeBarY = hudY + HUD_PADDING / camZ;

    for (let i = 1; i < MODES.length; i++) {
      const isActive = i === this.modeIndex;
      const barX = hudX + HUD_PADDING / camZ + (i - 1) * modeBarWidth;

      draw.fillRect(
        barX + 2 / camZ,
        modeBarY,
        modeBarWidth - 4 / camZ,
        modeBarHeight,
        {
          color: isActive ? 0x44aaff : 0x666666,
          alpha: isActive ? 1.0 : 0.5,
        },
      );
    }

    // Draw direction indicator if mode uses it
    if (mode.usesDirection) {
      const indicatorX = hudX + hudW / 2;
      const indicatorY = hudY + hudH / 2 + 5 / camZ;
      const indicatorRadius = DIRECTION_INDICATOR_RADIUS / camZ;

      // Draw circle outline
      draw.strokeCircle(indicatorX, indicatorY, indicatorRadius, {
        color: DIRECTION_INDICATOR_COLOR,
        alpha: 0.5,
        width: 1 / camZ,
      });

      // Draw direction arrow
      const dirAngle =
        (this.directionIndex / this.directionCount) * Math.PI * 2;
      const dir = V(Math.cos(dirAngle), Math.sin(dirAngle));
      const arrowLen = indicatorRadius * 0.8;

      const arrowTip = V(
        indicatorX + dir.x * arrowLen,
        indicatorY + dir.y * arrowLen,
      );
      const arrowBase = V(
        indicatorX - dir.x * arrowLen * 0.3,
        indicatorY - dir.y * arrowLen * 0.3,
      );

      draw.line(arrowBase.x, arrowBase.y, arrowTip.x, arrowTip.y, {
        color: DIRECTION_ARROW_COLOR,
        width: 3 / camZ,
      });

      // Arrowhead
      const headSize = 5 / camZ;
      const perp = dir.rotate90cw();
      const headLeft = V(
        arrowTip.x - dir.x * headSize + perp.x * headSize * 0.6,
        arrowTip.y - dir.y * headSize + perp.y * headSize * 0.6,
      );
      const headRight = V(
        arrowTip.x - dir.x * headSize - perp.x * headSize * 0.6,
        arrowTip.y - dir.y * headSize - perp.y * headSize * 0.6,
      );

      draw.fillPolygon([arrowTip, headLeft, headRight], {
        color: DIRECTION_ARROW_COLOR,
      });
    }
  }

  @on("destroy")
  onDestroy(): void {
    this.shader?.destroy();
    this.uniformBuffer?.destroy();
    this.bindGroup = null;
    this.shader = null;
    this.uniformBuffer = null;
  }
}
