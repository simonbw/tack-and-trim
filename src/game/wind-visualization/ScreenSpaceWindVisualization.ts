import { Container, Graphics, Renderer, Sprite, Texture } from "pixi.js";
import { Camera2d } from "../../core/graphics/Camera2d";
import { clamp, lerp } from "../../core/util/MathUtil";
import { V } from "../../core/Vector";
import { Wind } from "../Wind";
import { Viewport, WindVisualizationMode } from "./WindVisualizationMode";

// Grid configuration
const TARGET_TRIANGLES_PER_AXIS = 30;
const MIN_SPACING = 8;
const TRIANGLE_SIZE_RATIO = 0.7;

// Triangle rendering
const TRIANGLE_TEXTURE_SIZE = 32;
const TRIANGLE_ALPHA = 0.7;
const MIN_WIND_SPEED = 10;
const MAX_WIND_SPEED = 200;

// Colors
const TRIANGLE_COLOR = 0x88ccff;
const TRIANGLE_MODIFIED_COLOR = 0xffcc88;

/**
 * Screen-space wind visualization mode.
 * Grid spacing scales with viewport, anchored to camera center.
 */
export class ScreenSpaceWindVisualization implements WindVisualizationMode {
  private triangleSprites: Sprite[] = [];
  private triangleTexture: Texture | null = null;
  private container: Container | null = null;

  draw(
    wind: Wind,
    viewport: Viewport,
    camera: Camera2d,
    container: Container,
    renderer: Renderer
  ): void {
    // Lazy init
    if (!this.triangleTexture) {
      this.triangleTexture = this.createTriangleTexture(renderer);
      this.container = container;
    }

    const { left, right, top, bottom } = viewport;

    // Calculate grid spacing based on viewport size
    const viewportSize = Math.max(right - left, bottom - top);
    const gridSpacing = Math.max(
      MIN_SPACING,
      viewportSize / TARGET_TRIANGLES_PER_AXIS
    );

    // Anchor grid to camera center so it expands/contracts symmetrically when zooming
    const cameraCenter = camera.getPosition();
    const [cx, cy] = cameraCenter;
    const startX = cx - Math.ceil((cx - left) / gridSpacing) * gridSpacing;
    const startY = cy - Math.ceil((cy - top) / gridSpacing) * gridSpacing;
    const endX = right + gridSpacing;
    const endY = bottom + gridSpacing;

    // Calculate triangle size based on grid spacing
    const maxSize = gridSpacing * TRIANGLE_SIZE_RATIO;

    let spriteIndex = 0;

    for (let x = startX; x <= endX; x += gridSpacing) {
      for (let y = startY; y <= endY; y += gridSpacing) {
        const sprite = this.getTriangleSprite(spriteIndex, container);
        const used = this.updateTriangleSprite(wind, x, y, maxSize, sprite);
        if (used) spriteIndex++;
      }
    }

    // Hide unused sprites
    for (let i = spriteIndex; i < this.triangleSprites.length; i++) {
      this.triangleSprites[i].visible = false;
    }
  }

  hide(): void {
    for (const sprite of this.triangleSprites) {
      sprite.visible = false;
    }
  }

  private createTriangleTexture(renderer: Renderer): Texture {
    const g = new Graphics();
    const size = TRIANGLE_TEXTURE_SIZE;

    g.moveTo(size * 0.6, 0);
    g.lineTo(-size * 0.4, size * 0.35);
    g.lineTo(-size * 0.4, -size * 0.35);
    g.closePath();
    g.fill({ color: 0xffffff });

    return renderer.generateTexture(g);
  }

  private getTriangleSprite(index: number, container: Container): Sprite {
    while (this.triangleSprites.length <= index) {
      const sprite = new Sprite(this.triangleTexture!);
      sprite.anchor.set(0.5, 0.5);
      this.triangleSprites.push(sprite);
      container.addChild(sprite);
    }
    return this.triangleSprites[index];
  }

  private updateTriangleSprite(
    wind: Wind,
    x: number,
    y: number,
    maxSize: number,
    sprite: Sprite
  ): boolean {
    const point = V(x, y);
    const velocity = wind.getVelocityAtPoint(point);
    const baseVelocity = wind.getBaseVelocityAtPoint(point);
    const speed = velocity.magnitude;
    const angle = velocity.angle;

    if (speed < 1) {
      sprite.visible = false;
      return false;
    }

    const isModified = !velocity.equals(baseVelocity);
    const speedRatio = clamp(
      (speed - MIN_WIND_SPEED) / (MAX_WIND_SPEED - MIN_WIND_SPEED),
      0,
      1
    );

    const size = lerp(maxSize * 0.3, maxSize, speedRatio);
    const scale = size / TRIANGLE_TEXTURE_SIZE;

    sprite.visible = true;
    sprite.position.set(x, y);
    sprite.rotation = angle;
    sprite.scale.set(scale);
    sprite.tint = isModified ? TRIANGLE_MODIFIED_COLOR : TRIANGLE_COLOR;
    sprite.alpha = TRIANGLE_ALPHA;

    return true;
  }
}
