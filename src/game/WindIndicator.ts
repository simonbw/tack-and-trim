import { Graphics } from "pixi.js";
import BaseEntity from "../core/entity/BaseEntity";
import { createGraphics, GameSprite } from "../core/entity/GameSprite";
import { clamp, lerp } from "../core/util/MathUtil";
import { V, V2d } from "../core/Vector";
import { Boat } from "./boat/Boat";
import { Wind } from "./Wind";

// Visual configuration
const INDICATOR_RADIUS = 40;
const ARROW_MIN_LENGTH = 8;
const ARROW_MAX_LENGTH = 32;
const ARROW_WIDTH = 4;
const ARROW_HEAD_SIZE = 10;

// Interaction configuration
const MIN_WIND_SPEED = 20;
const MAX_WIND_SPEED = 200;
const DRAG_SPEED_SCALE = 5; // Pixels per unit of wind speed

// Position (offset from top-right corner)
const MARGIN_RIGHT = 60;
const MARGIN_TOP = 60;

// Colors
const BG_COLOR = 0x000000;
const BG_ALPHA = 0.3;
const BORDER_COLOR = 0xffffff;
const BORDER_ALPHA = 0.3;
const ARROW_COLOR = 0x4488ff;
const ARROW_HOVER_COLOR = 0x66aaff;
const ARROW_DRAG_COLOR = 0x88ccff;
const TICK_COLOR = 0xffffff;
const TICK_ALPHA = 0.3;
const VELOCITY_ARROW_COLOR = 0xff4444;

// Tick marks
const TICK_INNER_OFFSET = 8; // Distance from edge to inner tick point
const TICK_OUTER_OFFSET = 3; // Distance from edge to outer tick point
const TICK_CARDINAL_EXTRA = 3; // Extra length for cardinal directions (N/E/S/W)

// Arrow proportions
const ARROW_BASE_RATIO = 0.3; // How far back the arrow base extends (relative to length)
const ARROW_HEAD_WIDTH_RATIO = 0.5; // Width of arrow head (relative to head size)

// Velocity scaling
const MAX_BOAT_SPEED = 100; // Units per second for max arrow length

export class WindIndicator extends BaseEntity {
  sprite: GameSprite & Graphics;

  private isDragging: boolean = false;
  private indicatorCenter: V2d = V(0, 0);
  private screenSize: V2d = V(800, 600);

  constructor() {
    super();
    this.sprite = createGraphics("hud");
  }

  onResize({ size }: { size: V2d }): void {
    this.screenSize = V(size);
    this.updateIndicatorPosition();
  }

  private updateIndicatorPosition(): void {
    this.indicatorCenter = V(this.screenSize.x - MARGIN_RIGHT, MARGIN_TOP);
    this.sprite.position.set(this.indicatorCenter.x, this.indicatorCenter.y);
  }

  private getWind(): Wind | undefined {
    return this.game?.entities.getById("wind") as Wind | undefined;
  }

  private getBoat(): Boat | undefined {
    return this.game?.entities.getById("boat") as Boat | undefined;
  }

  private getMouseOffset(): V2d {
    const mousePos = this.game!.io.mousePosition;
    return mousePos.sub(this.indicatorCenter);
  }

  private isMouseOverIndicator(): boolean {
    const offset = this.getMouseOffset();
    return offset.magnitude <= INDICATOR_RADIUS;
  }

  onMouseDown(): void {
    if (this.isMouseOverIndicator()) {
      this.isDragging = true;
    }
  }

  onMouseUp(): void {
    this.isDragging = false;
  }

  onRender(): void {
    const wind = this.getWind();
    if (!wind) return;

    const isHovering = this.isMouseOverIndicator();

    // Handle dragging - update wind based on mouse position
    if (this.isDragging && this.game!.io.lmb) {
      const offset = this.getMouseOffset();
      const distance = offset.magnitude;

      if (distance > 5) {
        const angle = offset.angle;
        const speed = clamp(
          distance * DRAG_SPEED_SCALE,
          MIN_WIND_SPEED,
          MAX_WIND_SPEED
        );
        wind.setFromAngleAndSpeed(angle, speed);
      }
    } else if (this.isDragging) {
      this.isDragging = false;
    }

    // Draw the indicator
    this.drawIndicator(wind, isHovering);
  }

  private drawIndicator(wind: Wind, isHovering: boolean): void {
    const g = this.sprite;
    g.clear();

    // Determine color based on state
    let arrowColor = ARROW_COLOR;
    if (this.isDragging) {
      arrowColor = ARROW_DRAG_COLOR;
    } else if (isHovering) {
      arrowColor = ARROW_HOVER_COLOR;
    }

    // Draw background circle
    g.circle(0, 0, INDICATOR_RADIUS);
    g.fill({ color: BG_COLOR, alpha: BG_ALPHA });
    g.stroke({ color: BORDER_COLOR, alpha: BORDER_ALPHA, width: 2 });

    // Draw cardinal tick marks
    this.drawTicks(g);

    // Calculate arrow properties
    const windSpeed = wind.getSpeed();
    const windAngle = wind.getAngle();
    const speedRatio = clamp(
      (windSpeed - MIN_WIND_SPEED) / (MAX_WIND_SPEED - MIN_WIND_SPEED),
      0,
      1
    );
    const arrowLength = lerp(ARROW_MIN_LENGTH, ARROW_MAX_LENGTH, speedRatio);

    // Draw wind arrow
    this.drawArrow(g, windAngle, arrowLength, arrowColor);

    // Draw velocity arrow
    const boat = this.getBoat();
    if (boat) {
      const velocity = boat.getVelocity();
      const speed = velocity.magnitude;
      if (speed > 0.1) {
        const velocityAngle = velocity.angle;
        const speedRatio = clamp(speed / MAX_BOAT_SPEED, 0, 1);
        const velocityArrowLength = lerp(
          ARROW_MIN_LENGTH,
          ARROW_MAX_LENGTH,
          speedRatio
        );
        this.drawArrow(g, velocityAngle, velocityArrowLength, VELOCITY_ARROW_COLOR);
      }
    }
  }

  private drawTicks(g: Graphics): void {
    const innerRadius = INDICATOR_RADIUS - TICK_INNER_OFFSET;
    const outerRadius = INDICATOR_RADIUS - TICK_OUTER_OFFSET;

    // Draw tick marks at cardinal directions
    for (let i = 0; i < 8; i++) {
      const angle = (i * Math.PI) / 4;
      const isCardinal = i % 2 === 0;
      const inner = isCardinal ? innerRadius - TICK_CARDINAL_EXTRA : innerRadius;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);

      g.moveTo(cos * inner, sin * inner);
      g.lineTo(cos * outerRadius, sin * outerRadius);
      g.stroke({ color: TICK_COLOR, alpha: TICK_ALPHA, width: 1 });
    }
  }

  private drawArrow(
    g: Graphics,
    angle: number,
    length: number,
    color: number
  ): void {
    const dir = V(Math.cos(angle), Math.sin(angle));
    const perp = dir.rotate90cw();

    const tip = dir.mul(length);
    const base = dir.mul(-length * ARROW_BASE_RATIO);

    // Arrow shaft
    g.moveTo(base.x, base.y);
    g.lineTo(tip.x - dir.x * ARROW_HEAD_SIZE, tip.y - dir.y * ARROW_HEAD_SIZE);
    g.stroke({ color, width: ARROW_WIDTH, cap: "round" });

    // Arrow head (triangle)
    const headBase = tip.sub(dir.mul(ARROW_HEAD_SIZE));
    const headHalfWidth = ARROW_HEAD_SIZE * ARROW_HEAD_WIDTH_RATIO;
    const headLeft = headBase.add(perp.mul(headHalfWidth));
    const headRight = headBase.sub(perp.mul(headHalfWidth));

    g.moveTo(tip.x, tip.y);
    g.lineTo(headLeft.x, headLeft.y);
    g.lineTo(headRight.x, headRight.y);
    g.closePath();
    g.fill({ color });
  }
}
