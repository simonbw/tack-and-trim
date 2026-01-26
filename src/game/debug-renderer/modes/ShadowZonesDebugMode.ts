/**
 * Shadow Zones debug mode.
 *
 * Draws the actual shadow polygons used for wave shadowing calculations.
 * Use [ and ] to cycle through wave sources.
 */

import type { V2d } from "../../../core/Vector";
import type { DebugRenderMode, DebugRenderContext } from "../DebugRenderMode";
import { WaterInfo } from "../../world-data/water/WaterInfo";
import { WAVE_COMPONENTS } from "../../world-data/water/WaterConstants";
import type { ShadowPolygonRenderData } from "../../wave-physics/ShadowGeometry";

// Dim overlay
const DIM_COLOR = 0x000000;
const DIM_ALPHA = 0.4;

// Shadow polygon colors
const SHADOW_FILL_COLOR = 0x8844ff;
const SHADOW_FILL_ALPHA = 0.3;
const SHADOW_STROKE_COLOR = 0xaa66ff;
const SHADOW_STROKE_ALPHA = 0.8;
const SHADOW_STROKE_WIDTH = 2;

// Silhouette point markers
const LEFT_EDGE_COLOR = 0x0088ff;
const RIGHT_EDGE_COLOR = 0xff8800;
const MARKER_RADIUS = 5;

export class ShadowZonesDebugMode implements DebugRenderMode {
  id = "shadowZones";
  name = "Shadow Zones";

  private waveComponentIndex = 0;

  render(ctx: DebugRenderContext): void {
    const waterInfo = WaterInfo.maybeFromGame(ctx.game);
    const wavePhysicsManager = waterInfo?.getWavePhysicsManager();

    if (!wavePhysicsManager || !wavePhysicsManager.isInitialized()) return;

    // Draw dim overlay
    this.drawDimOverlay(ctx);

    // Draw shadow polygons
    const shadowPolygons = wavePhysicsManager.getShadowPolygons();
    if (shadowPolygons.length > 0) {
      this.drawShadowZones(
        ctx,
        shadowPolygons,
        wavePhysicsManager.getWaveDirection(),
      );
    }
  }

  private drawDimOverlay(ctx: DebugRenderContext): void {
    ctx.draw.fillRect(
      ctx.viewport.left,
      ctx.viewport.top,
      ctx.viewport.width,
      ctx.viewport.height,
      {
        color: DIM_COLOR,
        alpha: DIM_ALPHA,
      },
    );
  }

  private drawShadowZones(
    ctx: DebugRenderContext,
    polygons: ShadowPolygonRenderData[],
    _waveDirection: V2d,
  ): void {
    for (const polygon of polygons) {
      // Use pre-computed vertices from the shadow system
      const vertices = polygon.vertices;

      // Fill the shadow polygon
      ctx.draw.fillPolygon(vertices, {
        color: SHADOW_FILL_COLOR,
        alpha: SHADOW_FILL_ALPHA,
      });

      // Stroke the shadow polygon
      ctx.draw.strokePolygon(vertices, {
        color: SHADOW_STROKE_COLOR,
        alpha: SHADOW_STROKE_ALPHA,
        width: SHADOW_STROKE_WIDTH,
      });

      // Draw silhouette point markers
      ctx.draw.fillCircle(
        polygon.leftSilhouette.x,
        polygon.leftSilhouette.y,
        MARKER_RADIUS,
        {
          color: LEFT_EDGE_COLOR,
          alpha: 1.0,
        },
      );
      ctx.draw.fillCircle(
        polygon.rightSilhouette.x,
        polygon.rightSilhouette.y,
        MARKER_RADIUS,
        {
          color: RIGHT_EDGE_COLOR,
          alpha: 1.0,
        },
      );
    }
  }

  onKeyDown(
    _ctx: DebugRenderContext,
    key: string,
    _event: KeyboardEvent,
  ): boolean {
    if (key === "BracketLeft") {
      // [ key - previous wave
      this.waveComponentIndex =
        (this.waveComponentIndex - 1 + WAVE_COMPONENTS.length) %
        WAVE_COMPONENTS.length;
      return true;
    } else if (key === "BracketRight") {
      // ] key - next wave
      this.waveComponentIndex =
        (this.waveComponentIndex + 1) % WAVE_COMPONENTS.length;
      return true;
    }
    return false;
  }

  getHudInfo(_ctx: DebugRenderContext): string | null {
    const wave = WAVE_COMPONENTS[this.waveComponentIndex];
    const wavelength = wave[1];
    const direction = wave[2];
    const dirDeg = ((direction * 180) / Math.PI).toFixed(0);
    return `Wave ${this.waveComponentIndex}: λ=${wavelength}ft, dir=${dirDeg}°`;
  }
}
