import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import { Body } from "../../core/physics/body/Body";
import type { DynamicBody } from "../../core/physics/body/DynamicBody";
import { clamp } from "../../core/util/MathUtil";
import { V, V2d } from "../../core/Vector";
import { V3, V3d } from "../../core/Vector3";
import type { HullBoundaryData } from "../../core/physics/constraints/DeckContactConstraint";
import { LBF_TO_ENGINE } from "../physics-constants";
import { Pulley, type PulleyConfig } from "../rope/Pulley";
import { Rope, RopeConfig, type RopePathHint } from "../rope/Rope";
import { RopeObstacleCollider } from "../rope/RopeObstacleCollider";
import type { RopeObstacle } from "../rope/RopeObstacle";
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

/** Waypoint definition passed to Sheet for creating pulleys/winches. */
export interface SheetWaypoint {
  body: Body;
  localAnchor: V3d;
  /** Default "block" — free physics-driven sliding. */
  type?: "block" | "winch";
  /** Coulomb friction coefficient for rope sliding through this block.
   *  0 = frictionless (default). Typical: 0.05–0.3 for a block. */
  frictionCoefficient?: number;
  /** Sheave/winch drum radius in feet. 0 = point pulley. Default 0. */
  radius?: number;
}

/**
 * A single adjustable sheet (rope) connecting a sail to the boat.
 *
 * The rope is a fixed-length continuous particle chain with a free bitter end.
 * Blocks and winches are external Pulley entities that constrain the rope.
 */
export class Sheet extends BaseEntity {
  layer = "boat" as const;
  private rope: Rope;

  private config: SheetConfig;
  /** The hull body — used to compute the tailing direction toward the helm. */
  private hullBody: Body;
  /** The winch pulley, or null if no winch waypoint was specified. */
  private winch: Pulley | null = null;
  /** All pulleys (blocks and winches) on this sheet. */
  private pulleys: Pulley[] = [];
  private opacity: number = 1.0;
  /** Cumulative winch handle rotation (radians). */
  private winchAngle: number = 0;
  /** Previous working length, for computing winch rotation delta. */
  private prevWorkingLength: number = -1;

  constructor(
    bodyA: DynamicBody,
    private localAnchorA: V3d,
    bodyB: Body,
    private localAnchorB: V3d,
    config: Partial<SheetConfig> = {},
    waypoints: SheetWaypoint[] = [],
    private getDeckHeight?: (localX: number, localY: number) => number | null,
    private hullBoundary?: HullBoundaryData,
    private hullObstacles?: readonly RopeObstacle[],
  ) {
    super();

    this.config = { ...DEFAULT_CONFIG, ...config };
    this.hullBody = bodyB;

    // Compute total path distance for rope length calculation
    const pathPoints = [
      bodyA.toWorldFrame(V(localAnchorA[0], localAnchorA[1])),
      ...waypoints.map((w) =>
        w.body.toWorldFrame(V(w.localAnchor[0], w.localAnchor[1])),
      ),
      bodyB.toWorldFrame(V(localAnchorB[0], localAnchorB[1])),
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
        cdNormal: this.config.ropeDragCd ?? DEFAULT_CONFIG.ropeDragCd!,
      },
    };

    // Use waypoint positions as path hints for particle distribution
    const pathHints: RopePathHint[] = waypoints.map((w) => ({
      body: w.body,
      localAnchor: w.localAnchor,
    }));

    this.rope = this.addChild(
      new Rope(
        bodyA,
        localAnchorA,
        bodyB,
        localAnchorB,
        totalRopeLength,
        ropeConfig,
        pathHints,
      ),
    );

    // Rope-vs-obstacle segment collider (gunwale edges). Only spawned when
    // the sheet has hull obstacles AND the rope has deck contact (the
    // collider's gunwale prefilter relies on the per-particle inside flag).
    if (
      this.hullObstacles &&
      this.hullObstacles.length > 0 &&
      ropeConfig.deckContact
    ) {
      this.addChild(
        new RopeObstacleCollider(this.rope, this.hullBody, this.hullObstacles),
      );
    }

    // Create pulleys at waypoints
    const stiffness = ropeConfig.constraintStiffness;
    const relaxation = ropeConfig.constraintRelaxation;
    for (const wp of waypoints) {
      const pulleyConfig: PulleyConfig = {
        mode: wp.type ?? "block",
        frictionCoefficient: wp.frictionCoefficient,
        radius: wp.radius,
        stiffness,
        relaxation,
      };
      const pulley = this.addChild(
        new Pulley(this.rope, wp.body, wp.localAnchor, pulleyConfig),
      );
      this.pulleys.push(pulley);
      if (pulley.type === "winch" && !this.winch) {
        this.winch = pulley;
      }
    }
  }

  /**
   * Get the current working length (rope on the sail side of the winch).
   */
  getWorkingLength(): number {
    if (!this.winch) return this.rope.getLength();
    return this.winch.getWorkingLength();
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
    if (!this.winch) return;

    if (input === 0) {
      // Idle: ratchet prevents the sail from pulling rope out
      this.winch.setMode("ratchet");
      return;
    }

    // Clamp: don't trim shorter than minLength or ease longer than maxLength
    const workingLen = this.winch.getWorkingLength();
    if (input < 0 && workingLen <= this.config.minLength) return;
    if (input > 0 && workingLen >= this.config.maxLength) return;

    if (input < 0) {
      // Trimming: ratchet stays engaged (rope can only shorten on working side)
      // + apply tailing force to actively pull rope through
      this.winch.setMode("ratchet");

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
      this.winch.applyForce(forceMag, aftX, aftY, maxSpeed);
    } else {
      // Easing: free mode — sail loads pull the rope out naturally
      this.winch.setMode("free");
    }
  }

  /**
   * Release the sheet for tacking. Releases the winch grip so sail loads
   * can pull the rope out freely.
   */
  release(): void {
    if (!this.winch) return;
    this.winch.setMode("free");
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
  onTick(): void {
    this.updateWinchAngle();
  }

  /** Update winch handle rotation based on rope length change. */
  private updateWinchAngle(): void {
    if (!this.winch) return;
    const len = this.winch.getWorkingLength();
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
    return this.localAnchorA[2];
  }

  /** Z-height at anchor B (body B end). */
  getZB(): number {
    return this.localAnchorB[2];
  }

  /** Waypoint info for rendering — world position, type, and winch angle. */
  getWaypointInfo(): {
    position: V3d;
    type: "block" | "winch";
    winchAngle: number;
  }[] {
    return this.pulleys.map((p) => ({
      position: p.getWorldPosition(),
      type: p.type,
      winchAngle: p.type === "winch" ? this.winchAngle : 0,
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
