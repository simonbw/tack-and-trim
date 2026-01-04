import { Container, Graphics, Renderer, Sprite, Texture } from "pixi.js";
import { Camera2d } from "../../core/graphics/Camera2d";
import { clamp, lerp } from "../../core/util/MathUtil";
import { V } from "../../core/Vector";
import { Wind } from "../Wind";
import { Viewport, WindVisualizationMode } from "./WindVisualizationMode";

// Grid configuration - adaptive LOD
const BASE_SPACING = 8;
const MAX_LOD = 4;
const WORLD_TRIANGLE_SIZE = 12;
const BASE_VIEWPORT_SIZE = 400;

// Triangle rendering
const TRIANGLE_TEXTURE_SIZE = 32;
const TRIANGLE_ALPHA = 0.7;
const MIN_WIND_SPEED = 10;
const MAX_WIND_SPEED = 200;

// Colors
const TRIANGLE_COLOR = 0x88ccff;
const TRIANGLE_MODIFIED_COLOR = 0xffcc88;

/**
 * World-space wind visualization mode.
 * Fixed grid spacing anchored to world origin, with LOD-based fading.
 * Triangle size scales inversely with zoom to stay constant on screen.
 */
export class WorldSpaceWindVisualization implements WindVisualizationMode {
  private triangleSprites: Sprite[] = [];
  private triangleTexture: Texture | null = null;

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
    }

    const { left, right, top, bottom } = viewport;

    // Triangle size scales inversely with zoom to stay constant on screen
    const triangleSize = WORLD_TRIANGLE_SIZE / camera.z;

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

    let spriteIndex = 0;

    for (let x = startX; x <= endX; x += iterSpacing) {
      for (let y = startY; y <= endY; y += iterSpacing) {
        const triangleLOD = this.getTriangleLOD(x, y);
        const alpha = this.getLODAlpha(triangleLOD, lodValue);

        if (alpha > 0.01) {
          const sprite = this.getTriangleSprite(spriteIndex, container);
          const used = this.updateTriangleSprite(
            wind,
            x,
            y,
            triangleSize,
            sprite,
            alpha * TRIANGLE_ALPHA
          );
          if (used) spriteIndex++;
        }
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

  private updateTriangleSprite(
    wind: Wind,
    x: number,
    y: number,
    maxSize: number,
    sprite: Sprite,
    alpha: number
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
    sprite.alpha = alpha;

    return true;
  }
}
