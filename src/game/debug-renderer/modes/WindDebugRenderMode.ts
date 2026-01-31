/**
 * Wind Field Debug Mode
 *
 * Visualizes real-time wind data across the viewport using colored triangles and dots.
 * Triangle direction shows wind direction, size shows speed.
 *
 * Dots are shown for stationary/low wind (< 0.5 m/s).
 * Grid spacing automatically adjusts based on camera zoom (LOD).
 */

import { JSX } from "preact/jsx-runtime";
import { GameEventMap } from "../../../core/entity/Entity";
import { on } from "../../../core/entity/handler";
import { V, type V2d } from "../../../core/Vector";
import { WindQuery } from "../../world/query/WindQuery";
import { DebugRenderMode } from "./DebugRenderMode";

const TRIANGLE_SIZE = 2.0;
const TRIANGLES_PER_SCREEN_WIDTH = 32;

export class WindDebugRenderMode extends DebugRenderMode {
  layer = "windDebug";
  private windQuery: WindQuery;

  constructor() {
    super();
    this.windQuery = this.addChild(new WindQuery(() => this.getQueryPoints()));
  }

  /**
   * Main render method - draws the wind field visualization.
   */
  @on("render")
  onRender({ draw }: GameEventMap["render"]) {
    const scale = (1.0 / this.game.camera.z) * TRIANGLE_SIZE;

    const n = V();
    const p1 = V();
    const p2 = V();
    const p3 = V();

    for (const [point, result] of this.windQuery) {
      n.set(result.velocity).irotate90ccw();
      p1.set(point).iaddScaled(result.velocity, scale);
      p2.set(point).iaddScaled(n, 0.3 * scale);
      p3.set(point).iaddScaled(n, -0.3 * scale);
      draw.fillTriangle([p1, p2, p3], { alpha: 0.5, color: 0x00ffff });
    }
  }

  getQueryPoints(): V2d[] {
    const worldViewport = this.game.camera.getWorldViewport();

    // Step size is width rounded down to nearest power of two
    const stepSize =
      Math.pow(2, Math.floor(Math.log2(worldViewport.width))) /
      TRIANGLES_PER_SCREEN_WIDTH;

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
    return "Wind";
  }
}
