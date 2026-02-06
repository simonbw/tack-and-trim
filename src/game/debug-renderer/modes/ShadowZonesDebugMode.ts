/**
 * Shadow Zones debug mode.
 *
 * Draws the actual shadow polygons used for wave shadowing calculations.
 * Use [ and ] to cycle through wave sources.
 */

import type { V2d } from "../../../core/Vector";
import type { GameEventMap } from "../../../core/entity/Entity";
import { on } from "../../../core/entity/handler";
import { WavePhysicsResources } from "../../wave-physics/WavePhysicsResources";
import { WaterResources } from "../../world/water/WaterResources";
import type { ShadowPolygonRenderData } from "../../wave-physics/ShadowGeometry";
import { DebugRenderMode } from "./DebugRenderMode";

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

export class ShadowZonesDebugMode extends DebugRenderMode {
  layer = "windViz" as const;
  private waveComponentIndex = 0;

  @on("render")
  onRender({ draw }: GameEventMap["render"]): void {
    const wavePhysicsResources =
      this.game.entities.tryGetSingleton(WavePhysicsResources);
    const wavePhysicsManager = wavePhysicsResources?.getWavePhysicsManager();

    if (!wavePhysicsManager || !wavePhysicsManager.isInitialized()) return;

    // Draw dim overlay
    this.drawDimOverlay(draw);

    // Draw shadow polygons
    const shadowPolygons = wavePhysicsManager.getShadowPolygons();
    if (shadowPolygons.length > 0) {
      this.drawShadowZones(
        draw,
        shadowPolygons,
        wavePhysicsManager.getWaveDirection(),
      );
    }
  }

  private drawDimOverlay(draw: GameEventMap["render"]["draw"]): void {
    const viewport = this.game.camera.getWorldViewport();
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
  }

  private drawShadowZones(
    draw: GameEventMap["render"]["draw"],
    polygons: ShadowPolygonRenderData[],
    _waveDirection: V2d,
  ): void {
    for (const polygon of polygons) {
      // Use pre-computed vertices from the shadow system
      const vertices = polygon.vertices;

      // Fill the shadow polygon
      draw.fillPolygon(vertices, {
        color: SHADOW_FILL_COLOR,
        alpha: SHADOW_FILL_ALPHA,
      });

      // Stroke the shadow polygon
      draw.strokePolygon(vertices, {
        color: SHADOW_STROKE_COLOR,
        alpha: SHADOW_STROKE_ALPHA,
        width: SHADOW_STROKE_WIDTH,
      });

      // Draw silhouette point markers
      draw.fillCircle(
        polygon.leftSilhouette.x,
        polygon.leftSilhouette.y,
        MARKER_RADIUS,
        {
          color: LEFT_EDGE_COLOR,
          alpha: 1.0,
        },
      );
      draw.fillCircle(
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

  @on("keyDown")
  onKeyDown({ key }: GameEventMap["keyDown"]): void {
    const waterResources = this.game.entities.tryGetSingleton(WaterResources);
    const numWaves = waterResources?.getNumWaves() ?? 1;

    if (key === "BracketLeft") {
      // [ key - previous wave
      this.waveComponentIndex =
        (this.waveComponentIndex - 1 + numWaves) % numWaves;
    } else if (key === "BracketRight") {
      // ] key - next wave
      this.waveComponentIndex = (this.waveComponentIndex + 1) % numWaves;
    }
  }

  getModeName(): string {
    return "Shadow Zones";
  }

  getHudInfo(): string | null {
    const waterResources = this.game.entities.tryGetSingleton(WaterResources);
    if (!waterResources) return "No water resources";

    const waveConfig = waterResources.getWaveConfig();
    const source = waveConfig.sources[this.waveComponentIndex];
    if (!source) return `Wave ${this.waveComponentIndex}: not found`;

    const wavelength = source.wavelength;
    const direction = source.direction;
    const dirDeg = ((direction * 180) / Math.PI).toFixed(0);
    return `Wave ${this.waveComponentIndex}: λ=${wavelength}ft, dir=${dirDeg}°`;
  }
}
