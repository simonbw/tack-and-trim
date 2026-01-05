import { Container, Graphics, Renderer } from "pixi.js";
import { Camera2d, Viewport } from "../../core/graphics/Camera2d";
import { V, V2d } from "../../core/Vector";
import { Wind } from "../Wind";
import { WindVisualizationMode } from "./WindVisualizationMode";

// Grid configuration
const TARGET_STREAMLINES_PER_AXIS = 15;
const MIN_SPACING = 20;

// Streamline tracing
const STEP_SIZE_RATIO = 0.1; // Relative to grid spacing
const MAX_STEPS = 30; // Per direction (forward and backward)
const MIN_WIND_SPEED = 5;

// Rendering
const LINE_COLOR = 0x88ccff;
const LINE_MODIFIED_COLOR = 0xffcc88;
const LINE_ALPHA = 0.6;
const LINE_WIDTH = 1.5;

/**
 * Screen-space streamline visualization mode.
 * Traces curves along wind direction, anchored to camera center.
 */
export class ScreenSpaceStreamlineVisualization
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

    // Calculate grid spacing based on viewport size
    const viewportSize = Math.max(right - left, bottom - top);
    const gridSpacing = Math.max(
      MIN_SPACING,
      viewportSize / TARGET_STREAMLINES_PER_AXIS
    );
    const stepSize = gridSpacing * STEP_SIZE_RATIO;

    // Anchor grid to camera center
    const cameraCenter = camera.getPosition();
    const [cx, cy] = cameraCenter;
    const startX = cx - Math.ceil((cx - left) / gridSpacing) * gridSpacing;
    const startY = cy - Math.ceil((cy - top) / gridSpacing) * gridSpacing;
    const endX = right + gridSpacing;
    const endY = bottom + gridSpacing;

    // Trace and draw streamlines
    for (let x = startX; x <= endX; x += gridSpacing) {
      for (let y = startY; y <= endY; y += gridSpacing) {
        this.drawStreamline(wind, V(x, y), stepSize);
      }
    }
  }

  hide(): void {
    if (this.graphics) {
      this.graphics.visible = false;
    }
  }

  private drawStreamline(wind: Wind, seed: V2d, stepSize: number): void {
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
      current = current.add(direction.mul(stepSize));
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
      current = current.sub(direction.mul(stepSize));

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
      alpha: LINE_ALPHA,
      width: LINE_WIDTH,
    });
  }
}
