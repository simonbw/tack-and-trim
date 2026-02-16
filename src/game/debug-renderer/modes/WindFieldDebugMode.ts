/**
 * Wind Field debug mode.
 *
 * Shows wind triangles using an internal world-space visualization.
 * Uses WindQuery for GPU-accelerated wind sampling.
 */

import type { GameEventMap } from "../../../core/entity/Entity";
import { on } from "../../../core/entity/handler";
import type { Camera2d, Viewport } from "../../../core/graphics/Camera2d";
import type { Draw } from "../../../core/graphics/Draw";
import { clamp, lerp } from "../../../core/util/MathUtil";
import { V, type V2d } from "../../../core/Vector";
import { WindQuery } from "../../world/wind/WindQuery";
import type { WindResultView } from "../../world/wind/WindQueryResult";
import { DebugRenderMode } from "./DebugRenderMode";

// Dim overlay
const DIM_COLOR = 0x000000;
const DIM_ALPHA = 0.4;

// Grid configuration - adaptive LOD
const BASE_SPACING = 8;
const MIN_LOD = -5;
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

// Convert radians to compass direction
function radiansToCompass(radians: number): string {
  // Normalize to 0-2π
  const normalized = ((radians % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  // Convert to degrees (0° = East, going counter-clockwise)
  const degrees = (normalized * 180) / Math.PI;
  // Convert to compass (0° = North, going clockwise)
  // Wind direction in this system: 0 = right (East), π/2 = down (South)
  const compassDeg = (90 - degrees + 360) % 360;

  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const index = Math.round(compassDeg / 45) % 8;
  return directions[index];
}

export class WindFieldDebugMode extends DebugRenderMode {
  layer = "windViz" as const;
  private windQuery: WindQuery;

  // Cache the query points so we can use them when drawing
  private cachedQueryPoints: V2d[] = [];

  constructor() {
    super();

    // Wind query for grid + cursor positions
    this.windQuery = this.addChild(
      new WindQuery(() => this.getWindQueryPoints()),
    );
  }

  private getWindQueryPoints(): V2d[] {
    if (!this.game) return [];

    const viewport = this.game.camera.getWorldViewport();
    const gridPoints = this.getGridQueryPoints(viewport);

    // Add cursor position as last point for cursor info
    const mouseWorldPos = this.game.camera.toWorld(this.game.io.mousePosition);
    if (mouseWorldPos) {
      gridPoints.push(mouseWorldPos);
    }

    this.cachedQueryPoints = gridPoints;
    return gridPoints;
  }

  private getGridQueryPoints(viewport: Viewport): V2d[] {
    const points: V2d[] = [];
    const { left, right, top, bottom } = viewport;

    // Calculate continuous LOD value based on viewport size.
    const viewportSize = Math.max(right - left, bottom - top);
    const lodValue = Math.log2(viewportSize / BASE_VIEWPORT_SIZE);

    // Determine the coarsest LOD level we need to iterate at.
    const minVisibleLOD = clamp(Math.floor(lodValue), MIN_LOD, MAX_LOD);
    const iterSpacing = BASE_SPACING * Math.pow(2, minVisibleLOD);

    // Grid anchored to world origin (0,0).
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

  private drawGrid(
    results: WindResultView[],
    points: V2d[],
    viewport: Viewport,
    camera: Camera2d,
    draw: Draw,
  ): void {
    const { left, right, top, bottom } = viewport;

    // Triangle size scales inversely with zoom to stay constant on screen.
    const triangleSize = WORLD_TRIANGLE_SIZE / camera.z;

    // Calculate continuous LOD value based on viewport size.
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
    for (let lod = MAX_LOD; lod >= MIN_LOD; lod--) {
      const spacing = BASE_SPACING * Math.pow(2, lod);
      if (x % spacing === 0 && y % spacing === 0) {
        return lod;
      }
    }

    return MIN_LOD;
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

    // Draw a small circle for calm/zero wind.
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

    // Triangle vertices (pointing right, centered at origin).
    const tipX = size * 0.6;
    const backX = -size * 0.4;
    const wingY = size * 0.35;

    // Rotate and translate vertices.
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    const tipXFinal = tipX * cos + x;
    const tipYFinal = tipX * sin + y;
    const wingUpXFinal = backX * cos - wingY * sin + x;
    const wingUpYFinal = backX * sin + wingY * cos + y;
    const wingDownXFinal = backX * cos + wingY * sin + x;
    const wingDownYFinal = backX * sin - wingY * cos + y;

    draw.fillTriangle(
      { x: tipXFinal, y: tipYFinal },
      { x: wingUpXFinal, y: wingUpYFinal },
      { x: wingDownXFinal, y: wingDownYFinal },
      { color, alpha },
    );
  }

  @on("render")
  onRender({ draw }: GameEventMap["render"]): void {
    const camera = this.game.camera;
    const viewport = camera.getWorldViewport();

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

    // Draw wind visualization using query results
    if (
      this.windQuery.results.length > 0 &&
      this.cachedQueryPoints.length > 0
    ) {
      // Grid points are all but the last one (cursor)
      const gridPoints = this.cachedQueryPoints.slice(0, -1);
      const gridResults = this.windQuery.results.slice(0, -1);

      this.drawGrid(gridResults, gridPoints, viewport, camera, draw);
    }
  }

  getModeName(): string {
    return "Wind Field";
  }

  getCursorInfo(): string | null {
    const mouseWorldPos = this.game.camera.toWorld(this.game.io.mousePosition);
    if (!mouseWorldPos) return null;

    // Cursor wind is the last result (we add it as last query point)
    if (this.windQuery.results.length === 0) return null;

    const cursorResult =
      this.windQuery.results[this.windQuery.results.length - 1];
    const speed = cursorResult.speed;
    const direction = cursorResult.direction;

    const compass = radiansToCompass(direction);
    return `Wind: ${speed.toFixed(0)} ft/s ${compass}`;
  }
}
