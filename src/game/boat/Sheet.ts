import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import { Body } from "../../core/physics/body/Body";
import type { DynamicBody } from "../../core/physics/body/DynamicBody";
import { clamp, lerp, stepToward } from "../../core/util/MathUtil";
import { V2d } from "../../core/Vector";
import { Rope, RopeConfig } from "../rope/Rope";

export interface SheetConfig {
  minLength: number;
  maxLength: number;
  defaultLength: number;
  trimSpeed: number; // Ft / second when pulling in
  easeSpeed: number; // Ft / second when easing out
  ropePointCount: number;
  ropeThickness: number;
  ropeColor: number;
  /** Number of interior rope particles. Default 6. */
  particleCount?: number;
  /** Particle mass in lbs. Default 0.5. */
  particleMass?: number;
  /** Particle linear damping (0-1). Default 0.5. */
  ropeDamping?: number;
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
  particleCount: 6,
  particleMass: 0.5,
  ropeDamping: 0.5,
};

/**
 * A single adjustable sheet (rope) connecting two physics bodies.
 * Uses a chain of lightweight particles connected by upper-limit-only
 * distance constraints for stable, energy-dissipative force transmission.
 *
 * maxLength is computed from the actual endpoint geometry at construction
 * time — it's the distance the rope needs to be fully slack. The config's
 * maxLength is ignored; minLength is how short the crew can trim to.
 */
export class Sheet extends BaseEntity {
  layer = "boat" as const;
  private rope: Rope;

  private config: SheetConfig;
  /** Effective max length — computed from endpoint geometry. */
  private maxLength: number;
  private position: number; // 0 = full in, 1 = full out (single source of truth)
  private opacity: number = 1.0;

  constructor(
    bodyA: DynamicBody,
    localAnchorA: V2d,
    bodyB: Body,
    localAnchorB: V2d,
    config: Partial<SheetConfig> = {},
    private zA: number = 0,
    private zB: number = 0,
  ) {
    super();

    this.config = { ...DEFAULT_CONFIG, ...config };

    // Compute maxLength from the actual endpoint distance so the rope
    // is always long enough to be fully slack when released.
    const anchorAWorld = bodyA.toWorldFrame(localAnchorA);
    const anchorBWorld = bodyB.toWorldFrame(localAnchorB);
    const dx = anchorBWorld[0] - anchorAWorld[0];
    const dy = anchorBWorld[1] - anchorAWorld[1];
    this.maxLength = Math.sqrt(dx * dx + dy * dy);

    const ropeConfig: RopeConfig = {
      particleCount: this.config.particleCount,
      particleMass: this.config.particleMass,
      damping: this.config.ropeDamping,
    };

    // Start at maxLength (fully slack). The Rope constructor will clamp
    // up if needed, but with maxLength derived from geometry it shouldn't.
    this.position = 1;

    this.rope = new Rope(
      bodyA,
      [localAnchorA.x, localAnchorA.y, this.zA],
      bodyB,
      [localAnchorB.x, localAnchorB.y, this.zB],
      this.maxLength,
      ropeConfig,
    );

    // Sync position back from the Rope's actual length (in case it clamped).
    const range = this.maxLength - this.config.minLength;
    if (range > 0) {
      this.position = clamp(
        (this.rope.getLength() - this.config.minLength) / range,
        0,
        1,
      );
    }

    // Expose rope internals to the entity system for automatic
    // add/remove from the physics world on entity lifecycle.
    this.bodies = [...this.rope.getParticles()];
    this.constraints = [...this.rope.getConstraints()];
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
      (Math.abs(input) * baseSpeed) / (this.maxLength - this.config.minLength);

    this.position = stepToward(this.position, target, speed * dt);
    this.rope.setLength(this.getSheetLength());
  }

  /**
   * Instantly release the sheet to maximum length (for tacking).
   * Guarantees slack by using at least the current endpoint distance.
   */
  release(): void {
    this.position = 1;
    this.rope.releaseToSlack(this.getSheetLength());
  }

  /**
   * Set sheet to a specific position.
   * @param position 0 = full in, 1 = full out
   */
  setPosition(position: number): void {
    this.position = clamp(position, 0, 1);
    this.rope.setLength(this.getSheetLength());
  }

  getSheetPosition(): number {
    return this.position;
  }

  getSheetLength(): number {
    return lerp(this.config.minLength, this.maxLength, this.position);
  }

  /** Set the visual opacity of the sheet (0 = invisible, 1 = fully visible) */
  setOpacity(opacity: number): void {
    this.opacity = clamp(opacity, 0, 1);
  }

  /** Check if sheet is fully eased out (at max length) */
  isAtMaxLength(): boolean {
    return this.position >= 1;
  }

  @on("tick")
  onTick(): void {
    this.rope.tick();
  }

  /** Get world-space rope points (endpoints + particles). */
  getRopePoints(): readonly V2d[] {
    return this.rope.getPoints();
  }

  /** Get world-space rope points with z-values from particle positions. */
  getRopePointsWithZ(): {
    points: [number, number][];
    z: number[];
  } {
    return this.rope.getPointsWithZ();
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
    return this.config.ropeThickness;
  }

  /** Rope color for rendering. */
  getRopeColor(): number {
    return this.config.ropeColor;
  }
}
