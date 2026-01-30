/**
 * Water Debug Mode
 *
 * Visualizes real-time Gerstner wave simulation across the viewport.
 * Shows wave heights using color gradient and surface normals as arrows.
 *
 * Color gradient:
 * - Blue (darker): wave troughs (below sea level)
 * - Cyan/White: wave crests (above sea level)
 *
 * Grid spacing automatically adjusts based on camera zoom (LOD).
 */

import { JSX } from "preact/jsx-runtime";
import { GameEventMap } from "../../../core/entity/Entity";
import { on } from "../../../core/entity/handler";
import { V, type V2d } from "../../../core/Vector";
import { WaterQuery } from "../../world/query/WaterQuery";
import { DebugRenderMode } from "./DebugRenderMode";

const DOTS_PER_SCREEN_WIDTH = 32;
const DOT_SIZE = 0.3;
const NORMAL_ARROW_LENGTH = 1.5;

export class WaterDebugRenderMode extends DebugRenderMode {
  private waterQuery: WaterQuery;

  constructor() {
    super();
    this.waterQuery = this.addChild(
      new WaterQuery(() => this.getQueryPoints()),
    );
  }

  /**
   * Main render method - draws wave heights and normals.
   */
  @on("render")
  onRender({ draw }: GameEventMap["render"]) {
    const scale = (1.0 / this.game.camera.z) * DOT_SIZE;
    const normalLength = (1.0 / this.game.camera.z) * NORMAL_ARROW_LENGTH;

    for (const [point, result] of this.waterQuery) {
      // Color based on wave height
      // Height typically ranges from -1 to +1 for these wave amplitudes
      // Map to color: blue (trough) -> cyan -> white (crest)
      const normalizedHeight = (result.surfaceHeight + 1) / 2; // map [-1, 1] to [0, 1]
      const brightness = Math.max(0, Math.min(1, normalizedHeight));

      // Interpolate from dark blue (trough) to cyan/white (crest)
      const color = this.interpolateColor(0x0033aa, 0x00ffff, brightness);

      // Draw dot at wave position (offset by surface height)
      const wavePoint = V(point.x, point.y + result.surfaceHeight);
      draw.fillCircle(wavePoint.x, wavePoint.y, scale, { color, alpha: 0.7 });

      // Draw surface normal as small arrow (every 4th point for clarity)
      if (
        Math.floor(point.x / 10) % 4 === 0 &&
        Math.floor(point.y / 10) % 4 === 0
      ) {
        const normalEnd = wavePoint.add(result.normal.mul(normalLength));
        draw.line(wavePoint.x, wavePoint.y, normalEnd.x, normalEnd.y, {
          color: 0xffff00,
          alpha: 0.5,
        });
      }
    }
  }

  /**
   * Get grid of query points covering the visible viewport.
   */
  getQueryPoints(): V2d[] {
    const worldViewport = this.game.camera.getWorldViewport();

    // Step size based on viewport width
    const stepSize =
      Math.pow(2, Math.floor(Math.log2(worldViewport.width))) /
      DOTS_PER_SCREEN_WIDTH;

    // Round bounds to nearest multiple of stepSize
    const startX = Math.round(worldViewport.left / stepSize) * stepSize;
    const startY = Math.round(worldViewport.top / stepSize) * stepSize;
    const endX = Math.round(worldViewport.right / stepSize) * stepSize;
    const endY = Math.round(worldViewport.bottom / stepSize) * stepSize;

    const points: V2d[] = [];
    for (let x = startX; x <= endX; x += stepSize) {
      for (let y = startY; y <= endY; y += stepSize) {
        points.push(V(x, y));
      }
    }

    return points;
  }

  /**
   * Interpolate between two RGB colors.
   */
  private interpolateColor(color1: number, color2: number, t: number): number {
    const r1 = (color1 >> 16) & 0xff;
    const g1 = (color1 >> 8) & 0xff;
    const b1 = color1 & 0xff;

    const r2 = (color2 >> 16) & 0xff;
    const g2 = (color2 >> 8) & 0xff;
    const b2 = color2 & 0xff;

    const r = Math.round(r1 + (r2 - r1) * t);
    const g = Math.round(g1 + (g2 - g1) * t);
    const b = Math.round(b1 + (b2 - b1) * t);

    return (r << 16) | (g << 8) | b;
  }

  getModeName(): JSX.Element | string | null {
    return "Water";
  }
}
