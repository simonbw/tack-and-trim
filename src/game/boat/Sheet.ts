import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import { Body } from "../../core/physics/body/Body";
import type { DynamicBody } from "../../core/physics/body/DynamicBody";
import { clamp } from "../../core/util/MathUtil";
import { V2d } from "../../core/Vector";
import { Rope, RopeConfig, RopeWaypoint } from "../rope/Rope";

export interface SheetConfig {
  minLength: number;
  maxLength: number;
  defaultLength: number;
  trimSpeed: number; // Ft / second when pulling in
  easeSpeed: number; // Ft / second when easing out
  ropePointCount: number;
  ropeThickness: number;
  ropeColor: number;
  /** Second strand color for the twisted rope pattern. Default same as ropeColor. */
  ropeStrandColor?: number;
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
  ropeDamping: 0.85,
};

/**
 * A single adjustable sheet (rope) connecting two physics bodies.
 * Uses a chain of lightweight particles connected by upper-limit-only
 * distance constraints for stable, energy-dissipative force transmission.
 *
 * The rope has a fixed total length. Trimming moves rope through the
 * winch waypoint — the working side (sail) gets shorter while the tail
 * (crew) side gets longer, and vice versa when easing.
 */
export class Sheet extends BaseEntity {
  layer = "boat" as const;
  private rope: Rope;

  private config: SheetConfig;
  /** Index of the winch waypoint in the rope's waypoint array. */
  private winchIndex: number;
  private opacity: number = 1.0;

  constructor(
    bodyA: DynamicBody,
    localAnchorA: V2d,
    bodyB: Body,
    localAnchorB: V2d,
    config: Partial<SheetConfig> = {},
    private zA: number = 0,
    private zB: number = 0,
    waypoints: RopeWaypoint[] = [],
  ) {
    super();

    this.config = { ...DEFAULT_CONFIG, ...config };

    // Compute path segment distances for total rope length calculation
    const pathPoints = [
      bodyA.toWorldFrame(localAnchorA),
      ...waypoints.map((w) => w.body.toWorldFrame(w.localAnchor)),
      bodyB.toWorldFrame(localAnchorB),
    ];
    const segDists: number[] = [];
    for (let i = 0; i < pathPoints.length - 1; i++) {
      const dx = pathPoints[i + 1][0] - pathPoints[i][0];
      const dy = pathPoints[i + 1][1] - pathPoints[i][1];
      segDists.push(Math.sqrt(dx * dx + dy * dy));
    }

    // Find which waypoint is the winch (in the waypoints array, 0-based)
    const winchWaypointIdx = waypoints.findIndex((w) => w.type === "winch");

    // Compute working-side and tail-side path distances
    // The winch is at pathPoints index (winchWaypointIdx + 1)
    let workingPathDist = 0;
    let tailPathDist = 0;
    if (winchWaypointIdx >= 0) {
      const winchPathIdx = winchWaypointIdx + 1; // index in pathPoints
      for (let i = 0; i < winchPathIdx; i++) workingPathDist += segDists[i];
      for (let i = winchPathIdx; i < segDists.length; i++)
        tailPathDist += segDists[i];
    } else {
      for (const d of segDists) workingPathDist += d;
    }

    // Total rope length: working max + tail with slack margin.
    // The working side needs enough rope for maxLength (fully eased).
    // The tail needs at least the path distance from winch to cleat.
    const workingMax = Math.max(this.config.maxLength, workingPathDist * 1.1);
    const totalRopeLength =
      winchWaypointIdx >= 0 ? workingMax + tailPathDist * 1.5 : workingMax; // no winch — total = working

    const ropeConfig: RopeConfig = {
      particleCount: this.config.particleCount,
      particleMass: this.config.particleMass,
      damping: this.config.ropeDamping,
    };

    this.rope = new Rope(
      bodyA,
      [localAnchorA.x, localAnchorA.y, this.zA],
      bodyB,
      [localAnchorB.x, localAnchorB.y, this.zB],
      totalRopeLength,
      ropeConfig,
      waypoints,
    );

    // Find the winch waypoint in the rope's internal indexing
    this.winchIndex = this.rope.findWaypoint("winch");

    // If there's a winch, redistribute so working side starts at maxLength
    // (fully eased). The Rope constructor distributes proportionally, so
    // we transfer the excess from working side to tail.
    if (this.winchIndex >= 0) {
      const currentWorking = this.rope.getLengthBeforeWaypoint(this.winchIndex);
      const delta = currentWorking - workingMax;
      if (Math.abs(delta) > 0.01) {
        this.rope.transferAtWaypoint(this.winchIndex, delta);
      }
    }

    // Expose rope internals to the entity system for automatic
    // add/remove from the physics world on entity lifecycle.
    this.bodies = [...this.rope.getParticles()];
    this.constraints = [...this.rope.getConstraints()];
  }

  /**
   * Get the current working length (rope on the sail side of the winch).
   */
  getWorkingLength(): number {
    if (this.winchIndex < 0) return this.rope.getLength();
    return this.rope.getLengthBeforeWaypoint(this.winchIndex);
  }

  /**
   * Adjust sheet length based on input.
   * @param input -1 to 1 where negative = trim in (shorter), positive = ease out (longer)
   * @param dt Delta time in seconds
   */
  adjust(input: number, dt: number): void {
    if (input === 0) return;

    if (this.winchIndex < 0) {
      // No winch — fall back to setLength model
      const workingLen = this.rope.getLength();
      const range = this.config.maxLength - this.config.minLength;
      const position = clamp(
        (workingLen - this.config.minLength) / (range || 1),
        0,
        1,
      );
      const target = input < 0 ? 0 : 1;
      const baseSpeed =
        input < 0 ? this.config.trimSpeed : this.config.easeSpeed;
      const speed = (Math.abs(input) * baseSpeed) / (range || 1);
      const newPos = clamp(
        position + (target - position > 0 ? speed * dt : -speed * dt),
        0,
        1,
      );
      this.rope.setLength(
        this.config.minLength +
          newPos * (this.config.maxLength - this.config.minLength),
      );
      return;
    }

    // Winch model: transfer rope through the winch
    const speed =
      Math.abs(input) *
      (input < 0 ? this.config.trimSpeed : this.config.easeSpeed);
    // Positive amount = move rope from working (before winch) to tail (after winch)
    // input < 0 = trim in = working gets shorter = positive transfer
    const amount = (input < 0 ? 1 : -1) * speed * dt;

    // Clamp: don't trim shorter than minLength or ease longer than maxLength
    const workingLen = this.rope.getLengthBeforeWaypoint(this.winchIndex);
    let clamped = amount;
    if (clamped > 0) {
      // Trimming in — working side gets shorter
      const available = workingLen - this.config.minLength;
      clamped = Math.min(clamped, available);
    } else {
      // Easing out — working side gets longer
      const available = this.config.maxLength - workingLen;
      clamped = Math.max(clamped, -available);
    }

    if (Math.abs(clamped) > 1e-6) {
      this.rope.transferAtWaypoint(this.winchIndex, clamped);
    }
  }

  /**
   * Instantly release the sheet to maximum working length (for tacking).
   * Moves rope from the tail through the winch to the working side.
   */
  release(): void {
    if (this.winchIndex < 0) {
      this.rope.releaseToSlack(this.config.maxLength);
      return;
    }

    const workingLen = this.rope.getLengthBeforeWaypoint(this.winchIndex);
    const target = this.config.maxLength;
    const delta = workingLen - target; // negative = need to ease out
    if (delta < 0) {
      this.rope.transferAtWaypoint(this.winchIndex, delta);
    }
  }

  /**
   * Set sheet to a specific position.
   * @param position 0 = full in, 1 = full out
   */
  setPosition(position: number): void {
    const pos = clamp(position, 0, 1);
    const targetWorking =
      this.config.minLength +
      pos * (this.config.maxLength - this.config.minLength);

    if (this.winchIndex < 0) {
      this.rope.setLength(targetWorking);
      return;
    }

    const currentWorking = this.rope.getLengthBeforeWaypoint(this.winchIndex);
    const delta = currentWorking - targetWorking;
    if (Math.abs(delta) > 1e-6) {
      this.rope.transferAtWaypoint(this.winchIndex, delta);
    }
  }

  getSheetPosition(): number {
    const workingLen = this.getWorkingLength();
    const range = this.config.maxLength - this.config.minLength;
    return clamp((workingLen - this.config.minLength) / (range || 1), 0, 1);
  }

  getSheetLength(): number {
    return this.getWorkingLength();
  }

  /** Set the visual opacity of the sheet (0 = invisible, 1 = fully visible) */
  setOpacity(opacity: number): void {
    this.opacity = clamp(opacity, 0, 1);
  }

  /** Check if sheet is fully eased out (at max working length) */
  isAtMaxLength(): boolean {
    return this.getSheetPosition() >= 0.99;
  }

  @on("tick")
  onTick({
    dt,
  }: import("../../core/entity/Entity").GameEventMap["tick"]): void {
    this.rope.tick(dt);
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

  /** World positions of blocks/waypoints along this sheet. */
  getBlockPositions(): V2d[] {
    return this.rope.getWaypointPositions();
  }

  /** Rope thickness for rendering. */
  getRopeThickness(): number {
    return this.config.ropeThickness;
  }

  /** Rope color for rendering. */
  getRopeColor(): number {
    return this.config.ropeColor;
  }

  /** Second strand color for the twisted rope pattern. */
  getRopeStrandColor(): number {
    return this.config.ropeStrandColor ?? this.config.ropeColor;
  }
}
