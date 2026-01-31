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
import { colorRange } from "../../../core/util/ColorUtils";
import { clamp } from "../../../core/util/MathUtil";
import { V, type V2d } from "../../../core/Vector";
import { WaterQuery } from "../../world/query/WaterQuery";
import { DebugRenderMode } from "./DebugRenderMode";

const DOTS_PER_SCREEN_WIDTH = 48;
const DOT_SIZE = 1.5;
const NORMAL_ARROW_LENGTH = 3.5;

// Precompute color gradient for wave heights
const COLOR_GRADIENT = colorRange(0x0033aa, 0x00ffff, 256);

export class WaterDebugRenderMode extends DebugRenderMode {
  layer = "waterDebug";
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

    const wavePoint = V();
    const normalEnd = V();

    for (const [point, result] of this.waterQuery) {
      // Color based on wave height
      // Height typically ranges from -1 to +1 for these wave amplitudes
      // Map to color: blue (trough) -> cyan -> white (crest)
      const normalizedHeight = (result.surfaceHeight + 1) * 0.5; // map [-1, 1] to [0, 1]

      // Lookup precomputed color from gradient
      const colorIndex = clamp(Math.floor(normalizedHeight * 255), 0, 255);
      const color = COLOR_GRADIENT[colorIndex];

      // Draw dot at wave position (offset by surface height)
      wavePoint.set(point.x, point.y + result.surfaceHeight);
      draw.fillCircle(wavePoint.x, wavePoint.y, scale, { color, alpha: 0.7 });

      // Draw surface normal as small arrow (every 4th point for clarity)
      // Optimize: use bitwise AND instead of modulo for power-of-2 checks
      const px = Math.floor(point.x * 0.1); // divide by 10
      const py = Math.floor(point.y * 0.1);
      if ((px & 3) === 0 && (py & 3) === 0) {
        normalEnd.set(wavePoint).iaddScaled(result.normal, normalLength);
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

  getModeName(): JSX.Element | string | null {
    return "Water";
  }
}
