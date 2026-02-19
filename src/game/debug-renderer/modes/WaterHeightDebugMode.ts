/**
 * Water Height Debug Mode
 *
 * Visualizes water surface state and active water modifiers.
 * - HUD: count of active water modifiers
 * - Visual: rings/outlines for all active modifiers (wakes, ripples, currents, obstacles)
 * - Cursor: surface height, terrain depth, and turbulence at cursor position
 */

import type { GameEventMap } from "../../../core/entity/Entity";
import { on } from "../../../core/entity/handler";
import type { Draw } from "../../../core/graphics/Draw";
import {
  type GPUWaterModifierData,
  WaterModifierType,
} from "../../world/water/WaterModifierBase";
import { WaterQuery } from "../../world/water/WaterQuery";
import { WaterResources } from "../../world/water/WaterResources";
import { DebugRenderMode } from "./DebugRenderMode";

// Overlay
const OVERLAY_COLOR = 0x001133;
const OVERLAY_ALPHA = 0.35;

// Wake ring
const WAKE_RING_COLOR = 0x44aaff;
const WAKE_RING_ALPHA = 0.7;
const WAKE_SOURCE_COLOR = 0xffffff;
const WAKE_SOURCE_ALPHA = 0.9;
const WAKE_SOURCE_RADIUS = 2; // world-space ft

// Ripple ring
const RIPPLE_COLOR = 0x88ddff;
const RIPPLE_ALPHA = 0.6;

// Current bounds
const CURRENT_COLOR = 0x00ffaa;
const CURRENT_ALPHA = 0.5;

// Obstacle bounds
const OBSTACLE_COLOR = 0xff6600;
const OBSTACLE_ALPHA = 0.5;

const STROKE_WIDTH = 1;

export class WaterHeightDebugMode extends DebugRenderMode {
  layer = "windViz" as const;

  private waterQuery: WaterQuery;

  constructor() {
    super();
    this.waterQuery = this.addChild(
      new WaterQuery(() => this.getCursorQueryPoint()),
    );
  }

  private getCursorQueryPoint() {
    if (!this.game) return [];
    const mouseWorldPos = this.game.camera.toWorld(this.game.io.mousePosition);
    if (!mouseWorldPos) return [];
    return [mouseWorldPos];
  }

  @on("render")
  onRender({ draw }: GameEventMap["render"]): void {
    const camera = this.game.camera;
    const viewport = camera.getWorldViewport();

    draw.fillRect(
      viewport.left,
      viewport.top,
      viewport.width,
      viewport.height,
      {
        color: OVERLAY_COLOR,
        alpha: OVERLAY_ALPHA,
      },
    );

    const waterResources = this.game.entities.tryGetSingleton(WaterResources);
    if (!waterResources) return;

    for (const mod of waterResources.getCachedModifiers()) {
      this.drawModifier(mod, draw);
    }
  }

  private drawModifier(mod: GPUWaterModifierData, draw: Draw): void {
    switch (mod.data.type) {
      case WaterModifierType.Wake: {
        const data = mod.data;
        draw.strokeCircle(data.posX, data.posY, data.ringRadius, {
          color: WAKE_RING_COLOR,
          alpha: WAKE_RING_ALPHA * Math.max(0.1, data.turbulence),
          width: STROKE_WIDTH,
        });
        draw.fillCircle(data.posX, data.posY, WAKE_SOURCE_RADIUS, {
          color: WAKE_SOURCE_COLOR,
          alpha: WAKE_SOURCE_ALPHA,
        });
        break;
      }
      case WaterModifierType.Ripple: {
        const data = mod.data;
        const cx = (mod.bounds.lowerBound.x + mod.bounds.upperBound.x) / 2;
        const cy = (mod.bounds.lowerBound.y + mod.bounds.upperBound.y) / 2;
        draw.strokeCircle(cx, cy, data.radius, {
          color: RIPPLE_COLOR,
          alpha: RIPPLE_ALPHA,
          width: STROKE_WIDTH,
        });
        break;
      }
      case WaterModifierType.Current: {
        const b = mod.bounds;
        draw.strokeRect(
          b.lowerBound.x,
          b.lowerBound.y,
          b.upperBound.x - b.lowerBound.x,
          b.upperBound.y - b.lowerBound.y,
          { color: CURRENT_COLOR, alpha: CURRENT_ALPHA, width: STROKE_WIDTH },
        );
        break;
      }
      case WaterModifierType.Obstacle: {
        const b = mod.bounds;
        draw.strokeRect(
          b.lowerBound.x,
          b.lowerBound.y,
          b.upperBound.x - b.lowerBound.x,
          b.upperBound.y - b.lowerBound.y,
          { color: OBSTACLE_COLOR, alpha: OBSTACLE_ALPHA, width: STROKE_WIDTH },
        );
        break;
      }
    }
  }

  getModeName(): string {
    return "Water Height";
  }

  getHudInfo(): string | null {
    const waterResources = this.game.entities.tryGetSingleton(WaterResources);
    const count = waterResources?.getModifierCount() ?? 0;
    return `Water modifiers: ${count}`;
  }

  getCursorInfo(): string | null {
    if (this.waterQuery.length === 0) return null;

    const result = this.waterQuery.get(0);
    const height = result.surfaceHeight;
    const depth = result.depth;
    const turbulence = this.computeTurbulenceAtCursor();

    return [
      `Height: ${height.toFixed(2)} ft`,
      `Depth: ${depth.toFixed(1)} ft`,
      `Turbulence: ${(turbulence * 100).toFixed(0)}%`,
    ].join("\n");
  }

  /**
   * Approximate the combined wake turbulence at the cursor position.
   * Matches the GPU shader's Gaussian ring falloff for each wake modifier.
   */
  private computeTurbulenceAtCursor(): number {
    const mouseWorldPos = this.game.camera.toWorld(this.game.io.mousePosition);
    if (!mouseWorldPos) return 0;

    const waterResources = this.game.entities.tryGetSingleton(WaterResources);
    if (!waterResources) return 0;

    const x = mouseWorldPos.x;
    const y = mouseWorldPos.y;
    let total = 0;

    for (const mod of waterResources.getCachedModifiers()) {
      if (mod.data.type !== WaterModifierType.Wake) continue;
      const data = mod.data;
      const dx = x - data.posX;
      const dy = y - data.posY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const diff = dist - data.ringRadius;
      const falloff = Math.exp(-0.5 * (diff / data.ringWidth) ** 2);
      total += data.turbulence * falloff;
    }

    return Math.min(1, total);
  }
}
