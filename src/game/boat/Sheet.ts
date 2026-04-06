import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import { Body } from "../../core/physics/body/Body";
import type { DynamicBody } from "../../core/physics/body/DynamicBody";
import { clamp } from "../../core/util/MathUtil";
import { V, V2d } from "../../core/Vector";
import { LBF_TO_ENGINE, RHO_AIR, RHO_WATER } from "../physics-constants";
import { Rope, RopeConfig, RopeWaypoint } from "../rope/Rope";
import { WaterQuery } from "../world/water/WaterQuery";
import { WindQuery } from "../world/wind/WindQuery";
import type { RopePattern } from "./RopeShader";

export interface SheetConfig {
  minLength: number;
  maxLength: number;
  ropeThickness: number;
  /**
   * Fallback solid color if `ropePattern` is not specified.
   * Also used as the padding color when a pattern has fewer carriers than
   * the uniform buffer expects.
   */
  ropeColor: number;
  /**
   * Rope visual construction and carrier colors. If not specified, the rope
   * renders as a solid `ropeColor` laid rope.
   */
  ropePattern?: RopePattern;
  /** Particles per foot of rope. Default 1.5. */
  particlesPerFoot?: number;
  /**
   * Rope mass in lbs per foot. Real 5/16" line is ~0.03 lb/ft, but heavier
   * values improve simulation stability. Default 0.1.
   */
  massPerFoot?: number;
  /** Particle linear damping (0-1). Default 0.05 (low — fluid drag handles
   *  energy removal via wind/water-relative velocity instead). */
  ropeDamping?: number;
  /**
   * Rope diameter in feet, used for fluid drag area calculation.
   * Default 0.026 (≈ 5/16 inch, typical small-boat line).
   */
  ropeDiameter?: number;
  /**
   * Drag coefficient (Cd) for the rope cross-section. Cylinder crossflow
   * is ~1.2. Increase for braided/fuzzy rope, decrease for smooth line.
   * Default 1.2.
   */
  ropeDragCd?: number;
  /**
   * Tailing force in lbf (pounds-force) when trimming at full input.
   * Represents the mechanical advantage of the winch × crew effort.
   * Shift-held multiplies the input, simulating grinding harder.
   * Default 50.
   */
  winchForce?: number;
}

const DEFAULT_CONFIG: SheetConfig = {
  minLength: 6,
  maxLength: 35,
  ropeThickness: 0.75,
  ropeColor: 0x444444,
  particlesPerFoot: 1.5,
  massPerFoot: 0.1,
  ropeDamping: 0.05,
  winchForce: 50,
  ropeDiameter: 0.026,
  ropeDragCd: 0.6,
};

/**
 * A single adjustable sheet (rope) connecting a sail to the boat.
 *
 * The rope is a fixed-length continuous particle chain with a free bitter end.
 * Blocks are PulleyConstraint3D (rope slides freely through).
 * Winches are pulleys with a grip pin: when idle the grip locks the rope;
 * when the player trims, the grip releases and a force pulls rope through.
 */
export class Sheet extends BaseEntity {
  layer = "boat" as const;
  private rope: Rope;

  private config: SheetConfig;
  /** The hull body — used to compute the tailing direction toward the helm. */
  private hullBody: Body;
  /** Index of the winch in the rope's winch array, or -1. */
  private winchIndex: number;
  private opacity: number = 1.0;

  // Fluid drag queries and state
  private windQuery: WindQuery;
  private waterQuery: WaterQuery;
  private queryPoints: V2d[];
  /** 0.5 * Cd * ropeDiameter * chainLinkLength — precomputed drag area factor. */
  private dragHalfCdA: number;

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
    this.hullBody = bodyB;

    // Compute total path distance for rope length calculation
    const pathPoints = [
      bodyA.toWorldFrame(localAnchorA),
      ...waypoints.map((w) => w.body.toWorldFrame(w.localAnchor)),
      bodyB.toWorldFrame(localAnchorB),
    ];
    let totalPathDist = 0;
    for (let i = 0; i < pathPoints.length - 1; i++) {
      const dx = pathPoints[i + 1][0] - pathPoints[i][0];
      const dy = pathPoints[i + 1][1] - pathPoints[i][1];
      totalPathDist += Math.sqrt(dx * dx + dy * dy);
    }

    // Total rope length: enough for max working length plus tail
    const totalRopeLength = Math.max(
      this.config.maxLength * 1.3,
      totalPathDist * 1.3,
    );

    // Derive particle count and per-particle mass from rope length
    const particlesPerFt =
      this.config.particlesPerFoot ?? DEFAULT_CONFIG.particlesPerFoot!;
    const massPerFt = this.config.massPerFoot ?? DEFAULT_CONFIG.massPerFoot!;
    const particleCount = Math.max(
      4,
      Math.round(totalRopeLength * particlesPerFt),
    );
    const particleMass = (totalRopeLength * massPerFt) / particleCount;

    const ropeConfig: RopeConfig = {
      particleCount,
      particleMass,
      damping: this.config.ropeDamping,
      freeEndB: true,
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

    this.winchIndex = this.rope.findWinch();

    // Expose rope internals to the entity system
    this.bodies = [...this.rope.getParticles()];
    this.constraints = [...this.rope.getAllConstraints()];

    // Fluid drag: query wind and water at each particle position each frame.
    const particles = this.rope.getParticles();
    this.queryPoints = Array.from({ length: particles.length }, () => V(0, 0));
    this.windQuery = this.addChild(new WindQuery(() => this.queryPoints));
    this.waterQuery = this.addChild(new WaterQuery(() => this.queryPoints));

    // Precompute drag geometry: 0.5 * Cd * diameter * linkLength
    const cd = this.config.ropeDragCd ?? DEFAULT_CONFIG.ropeDragCd!;
    const diameter = this.config.ropeDiameter ?? DEFAULT_CONFIG.ropeDiameter!;
    this.dragHalfCdA = 0.5 * cd * diameter * this.rope.getChainLinkLength();
  }

  /**
   * Get the current working length (rope on the sail side of the winch).
   */
  getWorkingLength(): number {
    if (this.winchIndex < 0) return this.rope.getLength();
    return this.rope.getWorkingLength(this.winchIndex);
  }

  /**
   * Adjust sheet length based on player input.
   *
   * When trimming: ratchet mode (rope can slide in only) + tailing force
   * on the tail-side particle toward the helm, pulling rope through.
   * When easing: free mode — rope slides out under sail loads.
   * When idle (input = 0): ratchet mode — rope locked against easing.
   *
   * @param input Negative = trim in, positive = ease out.
   *   Magnitude controls force: 1 = normal, >1 = grinding harder (shift held).
   */
  adjust(input: number): void {
    if (this.winchIndex < 0) return;

    if (input === 0) {
      // Idle: ratchet prevents the sail from pulling rope out
      this.rope.setWinchMode(this.winchIndex, "ratchet");
      return;
    }

    // Clamp: don't trim shorter than minLength or ease longer than maxLength
    const workingLen = this.rope.getWorkingLength(this.winchIndex);
    if (input < 0 && workingLen <= this.config.minLength) return;
    if (input > 0 && workingLen >= this.config.maxLength) return;

    if (input < 0) {
      // Trimming: ratchet stays engaged (rope can only shorten on working side)
      // + apply tailing force to actively pull rope through
      this.rope.setWinchMode(this.winchIndex, "ratchet");

      // Force in engine units: winchForce (lbf) × input magnitude × lbf→engine
      const forceMag =
        Math.abs(input) *
        (this.config.winchForce ?? DEFAULT_CONFIG.winchForce!) *
        LBF_TO_ENGINE;

      // Tail direction: aft along the hull (toward the helm)
      const angle = this.hullBody.angle;
      const aftX = -Math.cos(angle);
      const aftY = -Math.sin(angle);
      this.rope.applyWinchForce(this.winchIndex, forceMag, aftX, aftY);
    } else {
      // Easing: free mode — sail loads pull the rope out naturally
      this.rope.setWinchMode(this.winchIndex, "free");
    }
  }

  /**
   * Release the sheet for tacking. Releases the winch grip so sail loads
   * can pull the rope out freely.
   */
  release(): void {
    if (this.winchIndex < 0) return;
    this.rope.setWinchMode(this.winchIndex, "free");
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
    this.updateQueryPoints();
    this.applyFluidDrag();
  }

  /** Sync query sample points with current particle world positions. */
  private updateQueryPoints(): void {
    const particles = this.rope.getParticles();
    for (let i = 0; i < particles.length; i++) {
      this.queryPoints[i].set(
        particles[i].position[0],
        particles[i].position[1],
      );
    }
  }

  /**
   * Apply per-particle aerodynamic or hydrodynamic drag using the fluid
   * velocity at each particle's position. Particles above the water surface
   * feel wind drag; particles below feel water drag. The drag force is
   * proportional to |v_relative|² (quadratic drag on a cylinder cross-section).
   *
   * This replaces bulk linear damping as the primary energy-removal mechanism,
   * giving physically correct behavior: a rope streaming downwind feels no
   * drag, while one whipping across the wind is heavily damped.
   */
  private applyFluidDrag(): void {
    const particles = this.rope.getParticles();
    const halfCdA = this.dragHalfCdA;
    const windAvail = this.windQuery.length > 0;
    const waterAvail = this.waterQuery.length > 0;

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];

      // Determine which medium: compare particle z to water surface height
      let rho: number;
      let fluidVx: number;
      let fluidVy: number;

      if (waterAvail) {
        const water = this.waterQuery.get(i);
        if (p.z <= water.surfaceHeight) {
          // Submerged: water drag with water current velocity
          rho = RHO_WATER;
          const wv = water.velocity;
          fluidVx = wv.x;
          fluidVy = wv.y;
        } else if (windAvail) {
          // Above water: air drag with wind velocity
          rho = RHO_AIR;
          const wv = this.windQuery.get(i).velocity;
          fluidVx = wv.x;
          fluidVy = wv.y;
        } else {
          continue;
        }
      } else if (windAvail) {
        // No water data yet — use wind only
        rho = RHO_AIR;
        const wv = this.windQuery.get(i).velocity;
        fluidVx = wv.x;
        fluidVy = wv.y;
      } else {
        // No query data available yet (first frame)
        continue;
      }

      // Relative velocity: particle velocity minus fluid velocity
      const vrx = p.velocity[0] - fluidVx;
      const vry = p.velocity[1] - fluidVy;
      const vrz = p.zVelocity; // fluid has no vertical component
      const vrMag = Math.sqrt(vrx * vrx + vry * vry + vrz * vrz);
      if (vrMag < 0.001) continue;

      // F = -0.5 * rho * Cd * A * |v_rel| * v_rel, converted to engine units
      const scale = -rho * halfCdA * vrMag * LBF_TO_ENGINE;
      p.applyForce3D(scale * vrx, scale * vry, scale * vrz, 0, 0, 0);
    }
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

  /** Rope construction and carrier colors for rendering. */
  getRopePattern(): RopePattern {
    return (
      this.config.ropePattern ?? {
        type: "laid",
        carriers: [this.config.ropeColor],
      }
    );
  }
}
