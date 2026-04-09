import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import { Body } from "../../core/physics/body/Body";
import type { DynamicBody } from "../../core/physics/body/DynamicBody";
import { clamp } from "../../core/util/MathUtil";
import { V2d } from "../../core/Vector";
import type { HullBoundaryData } from "../../core/physics/constraints/DeckContactConstraint";
import { LBF_TO_ENGINE } from "../physics-constants";
import { Rope, RopeConfig, RopeWaypoint } from "../rope/Rope";
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
  /**
   * Maximum rope speed through the winch in ft/s when trimming.
   * Models the limit of how fast a crew can crank. Force tapers to
   * zero as rope speed approaches this value. Default 3.
   */
  winchMaxSpeed?: number;
  /**
   * Tailing direction as a hull-local unit vector. The rope exits the
   * winch in this direction (transformed to world space each frame).
   * Default (-1, 0) = aft along the hull toward the helm.
   */
  tailDirection?: V2d;
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
  winchMaxSpeed: 3,
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
  /** Cumulative winch handle rotation (radians). */
  private winchAngle: number = 0;
  /** Previous working length, for computing winch rotation delta. */
  private prevWorkingLength: number = -1;

  constructor(
    bodyA: DynamicBody,
    localAnchorA: V2d,
    bodyB: Body,
    localAnchorB: V2d,
    config: Partial<SheetConfig> = {},
    private zA: number = 0,
    private zB: number = 0,
    waypoints: RopeWaypoint[] = [],
    private getDeckHeight?: (localX: number, localY: number) => number | null,
    private hullBoundary?: HullBoundaryData,
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

    const ropeDiameter =
      this.config.ropeDiameter ?? DEFAULT_CONFIG.ropeDiameter!;
    const ropeConfig: RopeConfig = {
      particleCount,
      particleMass,
      damping: this.config.ropeDamping,
      freeEndB: true,
      ropeDiameter,
      deckContact:
        this.getDeckHeight && this.hullBoundary
          ? {
              getDeckHeight: this.getDeckHeight,
              hullBoundary: this.hullBoundary,
            }
          : undefined,
      drag: {
        airDrag: true,
        waterDrag: true,
        ropeDiameter,
        ropeDragCd: this.config.ropeDragCd ?? DEFAULT_CONFIG.ropeDragCd!,
      },
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

    // Register rope particles as child entities (each owns its body + queries)
    for (const p of this.rope.getParticleEntities()) this.addChild(p);
    this.constraints = [...this.rope.getAllConstraints()];
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

      // Tail direction in world space (from hull-local config)
      const angle = this.hullBody.angle;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const td = this.config.tailDirection;
      // Default: aft along the hull (-1, 0) in local frame
      const lx = td ? td.x : -1;
      const ly = td ? td.y : 0;
      const aftX = cos * lx - sin * ly;
      const aftY = sin * lx + cos * ly;
      const maxSpeed =
        this.config.winchMaxSpeed ?? DEFAULT_CONFIG.winchMaxSpeed!;
      this.rope.applyWinchForce(
        this.winchIndex,
        forceMag,
        aftX,
        aftY,
        maxSpeed,
      );
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
    this.updateWinchAngle();
  }

  /** Update winch handle rotation based on rope length change. */
  private updateWinchAngle(): void {
    if (this.winchIndex < 0) return;
    const len = this.rope.getWorkingLength(this.winchIndex);
    if (this.prevWorkingLength >= 0) {
      const delta = this.prevWorkingLength - len;
      // Geared down: one full handle turn per ~6ft of rope travel
      this.winchAngle += delta / (6 / (2 * Math.PI));
    }
    this.prevWorkingLength = len;
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

  /** Waypoint info for rendering — position, type, and winch angle. */
  getWaypointInfo(): {
    position: V2d;
    type: "block" | "winch";
    winchAngle: number;
  }[] {
    return this.rope.getWaypointInfo().map((wp) => ({
      ...wp,
      winchAngle: wp.type === "winch" ? this.winchAngle : 0,
    }));
  }

  /** Rest length of one chain link (uniform segment spacing). */
  getRopeSegmentLength(): number {
    return this.rope.getChainLinkLength();
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
