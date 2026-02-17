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
import { clamp } from "../../../core/util/MathUtil";
import { profile } from "../../../core/util/Profiler";
import { V, type V2d } from "../../../core/Vector";
import { WindQuery } from "../../world/wind/WindQuery";
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
const SPEED_TO_LENGTH = 0.05;
const TRIANGLE_WIDTH = 0.3;

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

  // Pre-allocated point pool for zero-allocation point generation
  private pointPool: V2d[] = [];
  private queryPointsResult: V2d[] = [];
  private pointCount = 0;
  private triTip = V(0, 0);
  private triWingUp = V(0, 0);
  private triWingDown = V(0, 0);

  constructor() {
    super();

    // Wind query for grid + cursor positions
    this.windQuery = this.addChild(
      new WindQuery(() => this.getWindQueryPoints()),
    );
  }

  private allocPoint(x: number, y: number): V2d {
    let p: V2d;
    if (this.pointCount < this.pointPool.length) {
      p = this.pointPool[this.pointCount].set(x, y);
    } else {
      p = V(x, y);
      this.pointPool.push(p);
    }
    this.queryPointsResult[this.pointCount] = p;
    this.pointCount++;
    return p;
  }

  @profile
  private getWindQueryPoints(): V2d[] {
    if (!this.game) return [];

    this.pointCount = 0;

    const viewport = this.game.camera.getWorldViewport();
    this.updateGridQueryPoints(viewport);

    // Add cursor position as last point for cursor info
    const mouseWorldPos = this.game.camera.toWorld(this.game.io.mousePosition);
    if (mouseWorldPos) {
      this.allocPoint(mouseWorldPos.x, mouseWorldPos.y);
    }

    this.queryPointsResult.length = this.pointCount;
    return this.queryPointsResult;
  }

  private updateGridQueryPoints(viewport: Viewport): void {
    const { left, right, top, bottom } = viewport;

    // Calculate continuous LOD value based on viewport size.
    const viewportSize = Math.max(right - left, bottom - top);
    const lodValue = Math.log2(viewportSize / BASE_VIEWPORT_SIZE);

    // Single grid at finest visible spacing, consistent spatial order.
    const minVisibleLOD = clamp(Math.floor(lodValue), MIN_LOD, MAX_LOD);
    const spacing = BASE_SPACING * Math.pow(2, minVisibleLOD);

    const startX = Math.floor(left / spacing) * spacing;
    const startY = Math.floor(top / spacing) * spacing;
    const endX = right + spacing;
    const endY = bottom + spacing;

    for (let x = startX; x <= endX; x += spacing) {
      for (let y = startY; y <= endY; y += spacing) {
        const lod = this.getPointLOD(x, y, spacing, minVisibleLOD);
        if (this.getLODAlpha(lod, lodValue) > 0.01) {
          this.allocPoint(x, y);
        }
      }
    }
  }

  private getPointLOD(
    x: number,
    y: number,
    spacing: number,
    minVisibleLOD: number,
  ): number {
    const ix = Math.round(x / spacing);
    const iy = Math.round(y / spacing);
    const lodX =
      ix === 0
        ? MAX_LOD
        : Math.min(31 - Math.clz32(ix & -ix) + minVisibleLOD, MAX_LOD);
    const lodY =
      iy === 0
        ? MAX_LOD
        : Math.min(31 - Math.clz32(iy & -iy) + minVisibleLOD, MAX_LOD);
    return Math.min(lodX, lodY);
  }

  private drawGrid(
    query: WindQuery,
    points: ReadonlyArray<V2d>,
    viewport: Viewport,
    camera: Camera2d,
    draw: Draw,
  ): void {
    const triangleSize = WORLD_TRIANGLE_SIZE / camera.z;

    // Recompute LOD alpha from current viewport for smooth zoom transitions.
    const { left, right, top, bottom } = viewport;
    const viewportSize = Math.max(right - left, bottom - top);
    const lodValue = Math.log2(viewportSize / BASE_VIEWPORT_SIZE);
    const minVisibleLOD = clamp(Math.floor(lodValue), MIN_LOD, MAX_LOD);
    const spacing = BASE_SPACING * Math.pow(2, minVisibleLOD);

    // Skip the last point (cursor) — grid points only.
    const count = Math.min(query.length, points.length) - 1;
    for (let i = 0; i < count; i++) {
      const lod = this.getPointLOD(
        points[i].x,
        points[i].y,
        spacing,
        minVisibleLOD,
      );
      const alpha = this.getLODAlpha(lod, lodValue);
      if (alpha <= 0.01) continue;

      this.drawTriangle(
        query.get(i),
        points[i].x,
        points[i].y,
        triangleSize,
        alpha * TRIANGLE_ALPHA,
        draw,
      );
    }
  }

  private getLODAlpha(triangleLOD: number, lodValue: number): number {
    if (lodValue <= triangleLOD) return 1;
    if (lodValue >= triangleLOD + 1) return 0;
    return 1 - (lodValue - triangleLOD);
  }

  private drawTriangle(
    result: { speed: number; direction: number },
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
      draw.fillCircle(x, y, maxSize * TRIANGLE_WIDTH * 0.5, {
        color: CALM_WIND_COLOR,
        alpha,
      });
      return;
    }

    const length = speed * SPEED_TO_LENGTH * maxSize;
    const halfWidth = maxSize * TRIANGLE_WIDTH * 0.5;

    // Build triangle in local space, rotate, and translate to position.
    this.triTip
      .set(length * 0.6, 0)
      .irotate(angle)
      .iadd([x, y]);
    this.triWingUp
      .set(-length * 0.4, halfWidth)
      .irotate(angle)
      .iadd([x, y]);
    this.triWingDown
      .set(-length * 0.4, -halfWidth)
      .irotate(angle)
      .iadd([x, y]);

    draw.fillTriangle(this.triTip, this.triWingUp, this.triWingDown, {
      color: TRIANGLE_COLOR,
      alpha,
    });
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

    // Draw wind visualization using query results.
    // Use the query's synced points (not our current-frame pool) so points
    // and results stay aligned despite the one-frame readback latency.
    const queryPoints = this.windQuery.points;
    if (this.windQuery.length > 0 && queryPoints.length > 0) {
      this.drawGrid(this.windQuery, queryPoints, viewport, camera, draw);
    }
  }

  getModeName(): string {
    return "Wind Field";
  }

  getCursorInfo(): string | null {
    const mouseWorldPos = this.game.camera.toWorld(this.game.io.mousePosition);
    if (!mouseWorldPos || this.windQuery.length === 0) return null;

    // Cursor wind is the last result (we add it as last query point)
    const cursorResult = this.windQuery.get(this.windQuery.length - 1);
    const compass = radiansToCompass(cursorResult.direction);
    return `Wind: ${cursorResult.speed.toFixed(0)} ft/s ${compass}`;
  }
}
