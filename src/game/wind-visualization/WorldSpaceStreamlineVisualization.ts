import { Container, Graphics, Renderer } from "pixi.js";
import { Camera2d, Viewport } from "../../core/graphics/Camera2d";
import { V, V2d } from "../../core/Vector";
import { Wind } from "../Wind";
import { WindVisualizationMode } from "./WindVisualizationMode";

// Grid configuration - adaptive LOD
const BASE_SPACING = 40;
const MAX_LOD = 5;
const BASE_VIEWPORT_SIZE = 400;

// Streamline tracing
const WORLD_STEP_SIZE = 8;
const MAX_STEPS = 30;
const MIN_WIND_SPEED = 5;

// Rendering
const LINE_COLOR = 0x88ccff;
const LINE_MODIFIED_COLOR = 0xffcc88;
const LINE_ALPHA = 0.6;
const BASE_LINE_WIDTH = 1.5;

/**
 * World-space streamline visualization mode.
 * Fixed grid anchored to world origin, with LOD-based fading.
 * Line width scales inversely with zoom to stay constant on screen.
 */
export class WorldSpaceStreamlineVisualization
  implements WindVisualizationMode
{
  private graphics: Graphics | null = null;

  draw(
    wind: Wind,
    viewport: Viewport,
    camera: Camera2d,
    container: Container,
    _renderer: Renderer
  ): void {
    // Lazy init
    if (!this.graphics) {
      this.graphics = new Graphics();
      container.addChild(this.graphics);
    }

    this.graphics.clear();
    this.graphics.visible = true;

    const { left, right, top, bottom } = viewport;

    // Line width scales inversely with zoom to stay constant on screen
    const lineWidth = BASE_LINE_WIDTH / camera.z;

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
        const streamlineLOD = this.getStreamlineLOD(x, y);
        const alpha = this.getLODAlpha(streamlineLOD, lodValue);

        if (alpha > 0.01) {
          this.drawStreamline(wind, V(x, y), lineWidth, alpha * LINE_ALPHA);
        }
      }
    }
  }

  hide(): void {
    if (this.graphics) {
      this.graphics.visible = false;
    }
  }

  private getStreamlineLOD(x: number, y: number): number {
    for (let lod = MAX_LOD; lod >= 0; lod--) {
      const spacing = BASE_SPACING * Math.pow(2, lod);
      if (x % spacing === 0 && y % spacing === 0) {
        return lod;
      }
    }
    return 0;
  }

  private getLODAlpha(streamlineLOD: number, lodValue: number): number {
    if (lodValue <= streamlineLOD) return 1;
    if (lodValue >= streamlineLOD + 1) return 0;
    return 1 - (lodValue - streamlineLOD);
  }

  private drawStreamline(
    wind: Wind,
    seed: V2d,
    lineWidth: number,
    alpha: number
  ): void {
    const positions: V2d[] = [];
    let hasModified = false;

    // Trace forward from seed
    let current = seed.clone();
    for (let i = 0; i < MAX_STEPS; i++) {
      const velocity = wind.getVelocityAtPoint(current);
      const speed = velocity.magnitude;

      if (speed < MIN_WIND_SPEED) break;

      // Check if this point is in a modified region
      const baseVelocity = wind.getBaseVelocityAtPoint(current);
      if (!velocity.equals(baseVelocity)) {
        hasModified = true;
      }

      positions.push(current.clone());

      // Step forward along wind direction
      const direction = velocity.normalize();
      current = current.add(direction.mul(WORLD_STEP_SIZE));
    }

    // Trace backward from seed
    current = seed.clone();
    for (let i = 0; i < MAX_STEPS; i++) {
      const velocity = wind.getVelocityAtPoint(current);
      const speed = velocity.magnitude;

      if (speed < MIN_WIND_SPEED) break;

      // Check if this point is in a modified region
      const baseVelocity = wind.getBaseVelocityAtPoint(current);
      if (!velocity.equals(baseVelocity)) {
        hasModified = true;
      }

      // Step backward against wind direction
      const direction = velocity.normalize();
      current = current.sub(direction.mul(WORLD_STEP_SIZE));

      positions.unshift(current.clone());
    }

    // Draw the streamline if we have enough points
    if (positions.length < 2) return;

    const color = hasModified ? LINE_MODIFIED_COLOR : LINE_COLOR;

    this.graphics!.moveTo(positions[0].x, positions[0].y);
    for (let i = 1; i < positions.length; i++) {
      this.graphics!.lineTo(positions[i].x, positions[i].y);
    }
    this.graphics!.stroke({
      color,
      alpha,
      width: lineWidth,
    });
  }
}
