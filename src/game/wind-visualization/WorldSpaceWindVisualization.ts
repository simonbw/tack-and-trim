import { Camera2d, Viewport } from "../../core/graphics/Camera2d";
import type { Draw } from "../../core/graphics/Draw";
import { clamp, lerp } from "../../core/util/MathUtil";
import { V, V2d } from "../../core/Vector";
import type { WindResultView } from "../world/wind/WindQueryResult";
import { WindVisualizationMode } from "./WindVisualizationMode";

// Grid configuration - adaptive LOD
const BASE_SPACING = 8;
const MAX_LOD = 4;
const WORLD_TRIANGLE_SIZE = 24;
const BASE_VIEWPORT_SIZE = 400;

// Triangle rendering
const TRIANGLE_ALPHA = 0.7;
const MIN_WIND_SPEED = 10;
const MAX_WIND_SPEED = 200;

// Colors
const TRIANGLE_COLOR = 0x88ccff;
const CALM_WIND_COLOR = 0x666666;

/**
 * World-space wind visualization mode.
 * Fixed grid spacing anchored to world origin, with LOD-based fading.
 * Triangle size scales inversely with zoom to stay constant on screen.
 */
export class WorldSpaceWindVisualization implements WindVisualizationMode {
  /**
   * Get the grid points that need wind queries for a given viewport.
   */
  getQueryPoints(viewport: Viewport): V2d[] {
    const points: V2d[] = [];
    const { left, right, top, bottom } = viewport;

    // Calculate continuous LOD value based on viewport size
    const viewportSize = Math.max(right - left, bottom - top);
    const lodValue = Math.log2(viewportSize / BASE_VIEWPORT_SIZE);

    // Determine the coarsest LOD level we need to iterate at
    const minVisibleLOD = Math.max(0, Math.floor(lodValue));
    const iterSpacing = BASE_SPACING * Math.pow(2, minVisibleLOD);

    // Grid anchored to world origin (0,0)
    const startX = Math.floor(left / iterSpacing) * iterSpacing;
    const startY = Math.floor(top / iterSpacing) * iterSpacing;
    const endX = right + iterSpacing;
    const endY = bottom + iterSpacing;

    for (let x = startX; x <= endX; x += iterSpacing) {
      for (let y = startY; y <= endY; y += iterSpacing) {
        const triangleLOD = this.getTriangleLOD(x, y);
        const alpha = this.getLODAlpha(triangleLOD, lodValue);

        if (alpha > 0.01) {
          points.push(V(x, y));
        }
      }
    }

    return points;
  }

  /**
   * Draw the visualization using pre-queried wind results.
   */
  draw(
    results: WindResultView[],
    points: V2d[],
    viewport: Viewport,
    camera: Camera2d,
    draw: Draw,
  ): void {
    const { left, right, top, bottom } = viewport;

    // Triangle size scales inversely with zoom to stay constant on screen
    const triangleSize = WORLD_TRIANGLE_SIZE / camera.z;

    // Calculate continuous LOD value based on viewport size
    const viewportSize = Math.max(right - left, bottom - top);
    const lodValue = Math.log2(viewportSize / BASE_VIEWPORT_SIZE);

    for (let i = 0; i < points.length && i < results.length; i++) {
      const point = points[i];
      const result = results[i];

      const triangleLOD = this.getTriangleLOD(point.x, point.y);
      const alpha = this.getLODAlpha(triangleLOD, lodValue);

      if (alpha > 0.01) {
        this.drawTriangle(
          result,
          point.x,
          point.y,
          triangleSize,
          alpha * TRIANGLE_ALPHA,
          draw,
        );
      }
    }
  }

  private getTriangleLOD(x: number, y: number): number {
    for (let lod = MAX_LOD; lod >= 0; lod--) {
      const spacing = BASE_SPACING * Math.pow(2, lod);
      if (x % spacing === 0 && y % spacing === 0) {
        return lod;
      }
    }
    return 0;
  }

  private getLODAlpha(triangleLOD: number, lodValue: number): number {
    if (lodValue <= triangleLOD) return 1;
    if (lodValue >= triangleLOD + 1) return 0;
    return 1 - (lodValue - triangleLOD);
  }

  private drawTriangle(
    result: WindResultView,
    x: number,
    y: number,
    maxSize: number,
    alpha: number,
    draw: Draw,
  ): void {
    const speed = result.speed;
    const angle = result.direction;

    // Draw a small circle for calm/zero wind
    if (speed < 1) {
      draw.fillCircle(x, y, maxSize * 0.15, { color: CALM_WIND_COLOR, alpha });
      return;
    }

    const speedRatio = clamp(
      (speed - MIN_WIND_SPEED) / (MAX_WIND_SPEED - MIN_WIND_SPEED),
      0,
      1,
    );

    const size = lerp(maxSize * 0.3, maxSize, speedRatio);
    const color = TRIANGLE_COLOR;

    // Triangle vertices (pointing right, centered at origin)
    const tipX = size * 0.6;
    const backX = -size * 0.4;
    const wingY = size * 0.35;

    // Rotate and translate vertices
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    const tip = V(tipX * cos + x, tipX * sin + y);
    const wingUp = V(
      backX * cos - wingY * sin + x,
      backX * sin + wingY * cos + y,
    );
    const wingDown = V(
      backX * cos + wingY * sin + x,
      backX * sin - wingY * cos + y,
    );

    draw.fillPolygon([tip, wingUp, wingDown], { color, alpha });
  }
}
