import { Graphics } from "pixi.js";
import BaseEntity from "../../core/entity/BaseEntity";
import { createGraphics, GameSprite } from "../../core/entity/GameSprite";
import Body from "../../core/physics/body/Body";
import DistanceConstraint from "../../core/physics/constraints/DistanceConstraint";
import { lerp, stepToward } from "../../core/util/MathUtil";
import { V, V2d } from "../../core/Vector";
import { VerletRope } from "../rope/VerletRope";

export interface SheetConfig {
  minLength: number;
  maxLength: number;
  defaultLength: number;
  trimSpeed: number; // Ft / second when pulling in
  easeSpeed: number; // Ft / second when easing out
  ropePointCount: number;
  ropeThickness: number;
  ropeColor: number;
}

const DEFAULT_CONFIG: SheetConfig = {
  minLength: 6,
  maxLength: 35,
  defaultLength: 20,
  trimSpeed: 15,
  easeSpeed: 15,
  ropePointCount: 8,
  ropeThickness: 0.75,
  ropeColor: 0x444444,
};

/**
 * A single adjustable sheet (rope) connecting two physics bodies.
 * Can be trimmed in or eased out smoothly.
 */
export class Sheet extends BaseEntity {
  private sheetSprite: GameSprite & Graphics;
  private constraint: DistanceConstraint;
  private visualRope: VerletRope;

  private config: SheetConfig;
  private position: number; // 0 = full in, 1 = full out (single source of truth)

  constructor(
    private bodyA: Body,
    private localAnchorA: V2d,
    private bodyB: Body,
    private localAnchorB: V2d,
    config: Partial<SheetConfig> = {}
  ) {
    super();

    this.config = { ...DEFAULT_CONFIG, ...config };

    // Initialize position based on default length
    this.position =
      (this.config.defaultLength - this.config.minLength) /
      (this.config.maxLength - this.config.minLength);

    const initialLength = this.getSheetLength();

    this.sheetSprite = createGraphics("main");
    this.sprite = this.sheetSprite;

    // Create distance constraint configured as a rope:
    // - upperLimitEnabled: true (can't stretch beyond length)
    // - lowerLimitEnabled: false (can be slack/closer)
    this.constraint = new DistanceConstraint(bodyA, bodyB, {
      localAnchorA: [localAnchorA.x, localAnchorA.y],
      localAnchorB: [localAnchorB.x, localAnchorB.y],
    });

    this.constraint.lowerLimit = 0;
    this.constraint.lowerLimitEnabled = false;
    this.constraint.upperLimitEnabled = true;
    this.constraint.upperLimit = initialLength;

    this.constraints = [this.constraint];

    this.visualRope = new VerletRope({
      pointCount: this.config.ropePointCount ?? 8,
      restLength: initialLength,
      gravity: V(0, 3),
      damping: 0.98,
      thickness: this.config.ropeThickness ?? 0.75,
      color: this.config.ropeColor ?? 0x444444,
    });
  }

  /**
   * Adjust sheet length based on input.
   * @param input -1 to 1 where negative = trim in (shorter), positive = ease out (longer)
   * @param dt Delta time in seconds
   */
  adjust(input: number, dt: number): void {
    if (input === 0) return;

    const target = input < 0 ? 0 : 1;
    const baseSpeed = input < 0 ? this.config.trimSpeed : this.config.easeSpeed;
    const speed =
      (Math.abs(input) * baseSpeed) /
      (this.config.maxLength - this.config.minLength);

    this.position = stepToward(this.position, target, speed * dt);
    this.syncConstraintAndRope();
  }

  /**
   * Instantly release the sheet to maximum length (for tacking).
   */
  release(): void {
    this.position = 1;
    this.syncConstraintAndRope();
  }

  /**
   * Set sheet to a specific position.
   * @param position 0 = full in, 1 = full out
   */
  setPosition(position: number): void {
    this.position = Math.max(0, Math.min(1, position));
    this.syncConstraintAndRope();
  }

  private syncConstraintAndRope(): void {
    const length = this.getSheetLength();
    this.constraint.upperLimit = length;
    this.visualRope.setRestLength(length);
  }

  getSheetPosition(): number {
    return this.position;
  }

  getSheetLength(): number {
    return lerp(this.config.minLength, this.config.maxLength, this.position);
  }

  /** Set the visual opacity of the sheet (0 = invisible, 1 = fully visible) */
  setOpacity(opacity: number): void {
    this.sheetSprite.alpha = Math.max(0, Math.min(1, opacity));
  }

  /** Check if sheet is fully eased out (at max length) */
  isAtMaxLength(): boolean {
    return this.position >= 1;
  }

  private getAnchorAWorld(): V2d {
    const [x, y] = this.bodyA.position;
    return this.localAnchorA.rotate(this.bodyA.angle).iadd([x, y]);
  }

  private getAnchorBWorld(): V2d {
    const [x, y] = this.bodyB.position;
    return this.localAnchorB.rotate(this.bodyB.angle).iadd([x, y]);
  }

  onTick(dt: number): void {
    const anchorA = this.getAnchorAWorld();
    const anchorB = this.getAnchorBWorld();
    this.visualRope.update(anchorA, anchorB, dt);
  }

  onRender(): void {
    this.sheetSprite.clear();
    this.visualRope.render(this.sheetSprite);
  }
}
