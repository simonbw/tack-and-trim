import { BaseEntity } from "../../core/entity/BaseEntity";
import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import { Body } from "../../core/physics/body/Body";
import { DistanceConstraint } from "../../core/physics/constraints/DistanceConstraint";
import { clamp, lerp, stepToward } from "../../core/util/MathUtil";
import { V, V2d } from "../../core/Vector";
import { VerletRope } from "../rope/VerletRope";
import type { TiltTransform } from "./TiltTransform";

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
  layer = "boat" as const;
  private constraint: DistanceConstraint;
  private visualRope: VerletRope;

  private config: SheetConfig;
  private position: number; // 0 = full in, 1 = full out (single source of truth)
  private opacity: number = 1.0;

  constructor(
    private bodyA: Body,
    private localAnchorA: V2d,
    private bodyB: Body,
    private localAnchorB: V2d,
    config: Partial<SheetConfig> = {},
    private getTiltTransform?: () => TiltTransform,
    private zA: number = 0,
    private zB: number = 0,
  ) {
    super();

    this.config = { ...DEFAULT_CONFIG, ...config };

    // Initialize position based on default length
    this.position =
      (this.config.defaultLength - this.config.minLength) /
      (this.config.maxLength - this.config.minLength);

    const initialLength = this.getSheetLength();

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

    // Initialize rope at correct world positions so it doesn't snap from (0,0) on first frame
    this.visualRope.reset(this.getAnchorAWorld(), this.getAnchorBWorld());
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
    this.position = clamp(position, 0, 1);
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
    this.opacity = clamp(opacity, 0, 1);
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

  @on("tick")
  onTick({ dt }: GameEventMap["tick"]): void {
    const anchorA = this.getAnchorAWorld();
    const anchorB = this.getAnchorBWorld();
    this.visualRope.update(anchorA, anchorB, dt);
  }

  @on("render")
  onRender({ draw }: { draw: import("../../core/graphics/Draw").Draw }): void {
    if (this.opacity <= 0) return;

    const tilt = this.getTiltTransform?.();
    if (!tilt) {
      this.visualRope.render(draw, this.opacity);
      return;
    }

    const points = this.visualRope.getPoints();
    const n = points.length;
    if (n < 2) return;

    const path = draw.path();

    // Project first point at zA height
    const p0 = points[0];
    path.moveTo(
      p0.x + tilt.worldOffsetX(this.zA),
      p0.y + tilt.worldOffsetY(this.zA),
    );

    if (n === 2) {
      const p1 = points[1];
      path.lineTo(
        p1.x + tilt.worldOffsetX(this.zB),
        p1.y + tilt.worldOffsetY(this.zB),
      );
    } else {
      // Smooth quadratic bezier curve (same logic as VerletRope.render)
      for (let i = 0; i < n - 2; i++) {
        const t1 = (i + 1) / (n - 1);
        const t2 = (i + 2) / (n - 1);
        const z1 = lerp(this.zA, this.zB, t1);
        const z2 = lerp(this.zA, this.zB, t2);

        const p1x = points[i + 1].x + tilt.worldOffsetX(z1);
        const p1y = points[i + 1].y + tilt.worldOffsetY(z1);
        const p2x = points[i + 2].x + tilt.worldOffsetX(z2);
        const p2y = points[i + 2].y + tilt.worldOffsetY(z2);

        path.quadraticTo(p1x, p1y, (p1x + p2x) / 2, (p1y + p2y) / 2);
      }

      // Last segment
      const zLast = this.zB;
      const zSecondLast = lerp(this.zA, this.zB, (n - 2) / (n - 1));
      const pLast = points[n - 1];
      const pSL = points[n - 2];
      path.quadraticTo(
        pSL.x + tilt.worldOffsetX(zSecondLast),
        pSL.y + tilt.worldOffsetY(zSecondLast),
        pLast.x + tilt.worldOffsetX(zLast),
        pLast.y + tilt.worldOffsetY(zLast),
      );
    }

    // Set z for depth testing — use the average rope height
    const avgZ = (this.zA + this.zB) / 2;
    draw.renderer.setZ(avgZ);
    path.stroke(
      this.config.ropeColor ?? 0x444444,
      this.config.ropeThickness ?? 0.75,
      this.opacity,
    );
    draw.renderer.setZ(0);
  }
}
