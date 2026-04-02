import { BaseEntity } from "../../core/entity/BaseEntity";
import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import { Body } from "../../core/physics/body/Body";
import type { DynamicBody } from "../../core/physics/body/DynamicBody";
import { RopeSpring3D } from "../../core/physics/springs/RopeSpring3D";
import { clamp, lerp, stepToward } from "../../core/util/MathUtil";
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
  /** Spring stiffness (force per ft of extension). Default 200. */
  stiffness?: number;
  /** Spring damping coefficient. Default 50. */
  springDamping?: number;
  /** Maximum spring force (lbf). Prevents instability. Default 1000. */
  maxForce?: number;
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
  stiffness: 200,
  springDamping: 50,
  maxForce: 1000,
};

/**
 * A single adjustable sheet (rope) connecting two physics bodies.
 * Uses a RopeSpring3D (only applies force when taut) for soft, stable coupling.
 * Can be trimmed in or eased out smoothly.
 */
export class Sheet extends BaseEntity {
  layer = "boat" as const;
  private spring: RopeSpring3D;
  private visualRope: VerletRope;

  private config: SheetConfig;
  private position: number; // 0 = full in, 1 = full out (single source of truth)
  private opacity: number = 1.0;

  constructor(
    private bodyA: DynamicBody,
    private localAnchorA: V2d,
    private bodyB: Body,
    private localAnchorB: V2d,
    config: Partial<SheetConfig> = {},
    private getHullBody?: () => DynamicBody,
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

    // RopeSpring3D: only applies force when stretched beyond rest length.
    // Softer than a hard distance constraint, preventing instability when
    // coupling with the cloth sim's separate constraint solver.
    this.spring = new RopeSpring3D(bodyA, bodyB, {
      localAnchorA: [localAnchorA.x, localAnchorA.y, this.zA],
      localAnchorB: [localAnchorB.x, localAnchorB.y, this.zB],
      restLength: initialLength,
      stiffness: this.config.stiffness,
      damping: this.config.springDamping,
      maxForce: this.config.maxForce,
    });

    this.springs = [this.spring];

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
    this.syncSpringAndRope();
  }

  /**
   * Instantly release the sheet to maximum length (for tacking).
   */
  release(): void {
    this.position = 1;
    this.syncSpringAndRope();
  }

  /**
   * Set sheet to a specific position.
   * @param position 0 = full in, 1 = full out
   */
  setPosition(position: number): void {
    this.position = clamp(position, 0, 1);
    this.syncSpringAndRope();
  }

  private syncSpringAndRope(): void {
    const length = this.getSheetLength();
    this.spring.restLength = length;
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

  /** Get world-space rope simulation points. */
  getRopePoints(): readonly V2d[] {
    return this.visualRope.getPoints();
  }

  /** Get visual opacity. */
  getOpacity(): number {
    return this.opacity;
  }

  /** Z-height at anchor A (body A end). */
  getZA(): number {
    return this.zA;
  }

  /** Z-height at anchor B (body B end). */
  getZB(): number {
    return this.zB;
  }

  /** Rope thickness for rendering. */
  getRopeThickness(): number {
    return this.config.ropeThickness ?? 0.75;
  }

  /** Rope color for rendering. */
  getRopeColor(): number {
    return this.config.ropeColor ?? 0x444444;
  }
}
