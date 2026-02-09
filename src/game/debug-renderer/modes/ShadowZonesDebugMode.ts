/**
 * Shadow Zones debug mode.
 *
 * Draws the actual shadow polygons used for wave shadowing calculations.
 * Use [ and ] to cycle through wave sources.
 * Each wave source's polygons are drawn in a different color.
 */

import type { GameEventMap } from "../../../core/entity/Entity";
import { on } from "../../../core/entity/handler";
import { WavePhysicsResources } from "../../wave-physics/WavePhysicsResources";
import { WaterResources } from "../../world/water/WaterResources";
import type { ShadowPolygonRenderData } from "../../wave-physics/ShadowGeometry";
import { DebugRenderMode } from "./DebugRenderMode";

// Dim overlay
const DIM_COLOR = 0x000000;
const DIM_ALPHA = 0.4;

// Per-wave-source colors for shadow polygons
const WAVE_COLORS = [
  { fill: 0x8844ff, stroke: 0xaa66ff }, // Purple (wave 0)
  { fill: 0x4488ff, stroke: 0x66aaff }, // Blue (wave 1)
  { fill: 0x44ff88, stroke: 0x66ffaa }, // Green (wave 2)
  { fill: 0xff8844, stroke: 0xffaa66 }, // Orange (wave 3)
  { fill: 0xff4488, stroke: 0xff66aa }, // Pink (wave 4)
  { fill: 0xffff44, stroke: 0xffff66 }, // Yellow (wave 5)
  { fill: 0x44ffff, stroke: 0x66ffff }, // Cyan (wave 6)
  { fill: 0xff44ff, stroke: 0xff66ff }, // Magenta (wave 7)
];
const SHADOW_FILL_ALPHA = 0.3;
const SHADOW_STROKE_ALPHA = 0.8;
const SHADOW_STROKE_WIDTH = 2;

// Silhouette point markers
const LEFT_EDGE_COLOR = 0x0088ff;
const RIGHT_EDGE_COLOR = 0xff8800;
const MARKER_RADIUS = 5;

export class ShadowZonesDebugMode extends DebugRenderMode {
  layer = "windViz" as const;
  private selectedWaveIndex = -1; // -1 = show all

  @on("render")
  onRender({ draw }: GameEventMap["render"]): void {
    const wavePhysicsResources =
      this.game.entities.tryGetSingleton(WavePhysicsResources);
    const wavePhysicsManager = wavePhysicsResources?.getWavePhysicsManager();

    if (!wavePhysicsManager || !wavePhysicsManager.isInitialized()) return;

    // Draw dim overlay
    this.drawDimOverlay(draw);

    // Draw shadow polygons for each wave source
    const waveCount = wavePhysicsManager.getWaveSourceCount();
    for (let w = 0; w < waveCount; w++) {
      if (this.selectedWaveIndex >= 0 && this.selectedWaveIndex !== w) continue;

      const polygons = wavePhysicsManager.getShadowPolygonsForWave(w);
      if (polygons.length > 0) {
        const colors = WAVE_COLORS[w % WAVE_COLORS.length];
        this.drawShadowZones(draw, polygons, colors);
      }
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
    colors: { fill: number; stroke: number },
  ): void {
    for (const polygon of polygons) {
      const vertices = polygon.vertices;

      // Fill the shadow polygon
      draw.fillPolygon(vertices, {
        color: colors.fill,
        alpha: SHADOW_FILL_ALPHA,
      });

      // Stroke the shadow polygon
      draw.strokePolygon(vertices, {
        color: colors.stroke,
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
      // [ key - previous wave (or show all)
      this.selectedWaveIndex =
        this.selectedWaveIndex <= -1
          ? numWaves - 1
          : this.selectedWaveIndex - 1;
    } else if (key === "BracketRight") {
      // ] key - next wave (or show all)
      this.selectedWaveIndex =
        this.selectedWaveIndex >= numWaves - 1
          ? -1
          : this.selectedWaveIndex + 1;
    }
  }

  getModeName(): string {
    return "Shadow Zones";
  }

  getHudInfo(): string | null {
    const waterResources = this.game.entities.tryGetSingleton(WaterResources);
    if (!waterResources) return "No water resources";

    const waveConfig = waterResources.getWaveConfig();

    if (this.selectedWaveIndex < 0) {
      return `All waves (${waveConfig.sources.length} sources) [/] to cycle`;
    }

    const source = waveConfig.sources[this.selectedWaveIndex];
    if (!source) return `Wave ${this.selectedWaveIndex}: not found`;

    const wavelength = source.wavelength;
    const direction = source.direction;
    const dirDeg = ((direction * 180) / Math.PI).toFixed(0);
    return `Wave ${this.selectedWaveIndex}: λ=${wavelength}ft, dir=${dirDeg}°`;
  }
}
