import { Container, Graphics } from "pixi.js";
import BaseEntity from "../core/entity/BaseEntity";
import { GameSprite } from "../core/entity/GameSprite";
import { V } from "../core/Vector";
import { clamp, lerp } from "../core/util/MathUtil";
import { LAYERS } from "../config/layers";
import { Wind } from "./Wind";

// Grid configuration
const GRID_SPACING = 50;

// Triangle configuration
const TRIANGLE_MIN_SIZE = 8;
const TRIANGLE_MAX_SIZE = 24;
const MIN_WIND_SPEED = 20;
const MAX_WIND_SPEED = 200;

// Colors
const TRIANGLE_COLOR = 0x88ccff;
const TRIANGLE_ALPHA = 0.7;
const TRIANGLE_MODIFIED_COLOR = 0xffcc88;

const MODIFIER_FILL_COLOR = 0xffaa44;
const MODIFIER_FILL_ALPHA = 0.15;
const MODIFIER_STROKE_COLOR = 0xffaa44;
const MODIFIER_STROKE_ALPHA = 0.4;
const MODIFIER_STROKE_WIDTH = 2;

const DIM_COLOR = 0x000000;
const DIM_ALPHA = 0.4;

export class WindVisualization extends BaseEntity {
  sprite: GameSprite;
  private dimGraphics: Graphics;
  private gridGraphics: Graphics;
  private visible: boolean = false;

  constructor() {
    super();
    const container = new Container() as Container & GameSprite;
    container.layerName = "windViz";

    this.dimGraphics = new Graphics();
    this.gridGraphics = new Graphics();
    container.addChild(this.dimGraphics);
    container.addChild(this.gridGraphics);

    this.sprite = container;
  }

  onKeyDown({ key }: { key: string }): void {
    if (key === "KeyV") {
      this.toggle();
    }
  }

  private toggle(): void {
    this.visible = !this.visible;
    LAYERS.windViz.container.alpha = this.visible ? 1 : 0;
  }

  private getWind(): Wind | undefined {
    return this.game?.entities.getById("wind") as Wind | undefined;
  }

  onRender(): void {
    this.dimGraphics.clear();
    this.gridGraphics.clear();

    if (!this.visible) return;

    const wind = this.getWind();
    if (!wind) return;

    const camera = this.game!.camera;
    const { left, right, top, bottom } = camera.getWorldViewport();

    // Draw dim overlay (world-space, covering viewport)
    this.dimGraphics.rect(left, top, right - left, bottom - top);
    this.dimGraphics.fill({ color: DIM_COLOR, alpha: DIM_ALPHA });

    // Draw modifier circles
    this.drawModifierCircles(wind);

    // Draw triangle grid
    this.drawTriangleGrid(wind, left, top, right, bottom);
  }

  private drawModifierCircles(wind: Wind): void {
    for (const modifier of wind.getModifiers()) {
      const pos = modifier.getWindModifierPosition();
      const radius = modifier.getWindModifierInfluenceRadius();

      this.gridGraphics.circle(pos.x, pos.y, radius);
      this.gridGraphics.fill({
        color: MODIFIER_FILL_COLOR,
        alpha: MODIFIER_FILL_ALPHA,
      });
      this.gridGraphics.stroke({
        color: MODIFIER_STROKE_COLOR,
        alpha: MODIFIER_STROKE_ALPHA,
        width: MODIFIER_STROKE_WIDTH,
      });
    }
  }

  private drawTriangleGrid(
    wind: Wind,
    left: number,
    top: number,
    right: number,
    bottom: number
  ): void {
    const startX = Math.floor(left / GRID_SPACING) * GRID_SPACING;
    const startY = Math.floor(top / GRID_SPACING) * GRID_SPACING;
    const endX = right + GRID_SPACING;
    const endY = bottom + GRID_SPACING;

    for (let x = startX; x <= endX; x += GRID_SPACING) {
      for (let y = startY; y <= endY; y += GRID_SPACING) {
        this.drawWindTriangle(wind, x, y);
      }
    }
  }

  private drawWindTriangle(wind: Wind, x: number, y: number): void {
    const velocity = wind.getVelocityAtPoint([x, y]);
    const baseVelocity = wind.getBaseVelocityAtPoint([x, y]);
    const speed = velocity.magnitude;
    const angle = velocity.angle;

    if (speed < 1) return;

    const isModified = !velocity.equals(baseVelocity);
    const speedRatio = clamp(
      (speed - MIN_WIND_SPEED) / (MAX_WIND_SPEED - MIN_WIND_SPEED),
      0,
      1
    );
    const size = lerp(TRIANGLE_MIN_SIZE, TRIANGLE_MAX_SIZE, speedRatio);
    const color = isModified ? TRIANGLE_MODIFIED_COLOR : TRIANGLE_COLOR;

    this.drawTriangle(x, y, angle, size, color);
  }

  private drawTriangle(
    x: number,
    y: number,
    angle: number,
    size: number,
    color: number
  ): void {
    const dir = V(Math.cos(angle), Math.sin(angle));
    const perp = dir.rotate90cw();

    const tip = V(x, y).add(dir.mul(size * 0.6));
    const baseCenter = V(x, y).sub(dir.mul(size * 0.4));
    const left = baseCenter.add(perp.mul(size * 0.35));
    const right = baseCenter.sub(perp.mul(size * 0.35));

    this.gridGraphics.moveTo(tip.x, tip.y);
    this.gridGraphics.lineTo(left.x, left.y);
    this.gridGraphics.lineTo(right.x, right.y);
    this.gridGraphics.closePath();
    this.gridGraphics.fill({ color, alpha: TRIANGLE_ALPHA });
  }
}
