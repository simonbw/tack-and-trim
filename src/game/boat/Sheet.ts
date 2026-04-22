import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { Body } from "../../core/physics/body/Body";
import type { HullBoundaryData } from "../../core/physics/constraints/DeckContactConstraint";
import { clamp } from "../../core/util/MathUtil";
import { V, V2d } from "../../core/Vector";
import { V3d } from "../../core/Vector3";
import { LBF_TO_ENGINE } from "../physics-constants";
import { RopeBlock } from "../rope/RopeBlock";
import { RopeNetwork, type RopeNetworkNodeSpec } from "../rope/RopeNetwork";
import { RopeRender } from "../rope/RopeRender";
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
  /**
   * Rope diameter in feet. Default 0.026 (≈ 5/16 inch, typical small-boat
   * line). Retained for future drag/rendering use; unused by the capstan
   * solver.
   */
  ropeDiameter?: number;
  /**
   * Maximum rope speed through the winch in ft/s when trimming.
   * Models the limit of how fast a crew can crank.
   * Default 3.
   */
  winchMaxSpeed?: number;
  /**
   * Tailing force in lbf. Retained for config compat with the old
   * force-based winch API and the boat editor UI; the new capstan-network
   * rope uses `winchMaxSpeed` directly and ignores this field. Slated for
   * removal in Phase 5.
   */
  winchForce?: number;
  /**
   * Tailing direction as a hull-local unit vector. Unused by the capstan
   * solver (direction is implicit in the node ordering); retained for
   * possible future use by the render layer.
   */
  tailDirection?: V2d;
}

const DEFAULT_CONFIG: SheetConfig = {
  minLength: 6,
  maxLength: 35,
  ropeThickness: 0.75,
  ropeColor: 0x444444,
  winchMaxSpeed: 3,
  // Hand-winch peak force in lbf. Bounds how much tension the winch can
  // drive into the rope before stalling; prevents a player cranking
  // against a taut sheet from generating runaway yaw torque on the hull.
  winchForce: 250,
  ropeDiameter: 0.026,
};

/** Waypoint definition passed to Sheet for creating pulleys/winches. */
export interface SheetWaypoint {
  body: Body;
  localAnchor: V3d;
  /** Default "block" — free-sliding. */
  type?: "block" | "winch";
  /** Coulomb friction coefficient for rope sliding through this block.
   *  0 = frictionless (default). Typical: 0.05–0.3 for a block. */
  frictionCoefficient?: number;
  /**
   * Sheave/winch drum radius in feet. Retained for compat with the old
   * API but ignored by the capstan solver (tension redirection is purely
   * Coulomb — no sheave geometry). Default 0.
   */
  radius?: number;
}

/**
 * A single adjustable sheet (rope) connecting a sail to the boat.
 *
 * The rope is a capstan network: ordered nodes with scalar tensions and
 * lengths between them. Blocks and winches are interior nodes with friction;
 * player input adjusts the winch node's length-flow rate and ratchet state.
 */
export class Sheet extends BaseEntity {
  layer = "boat" as const;
  private rope: RopeNetwork;
  private render: RopeRender;

  private config: SheetConfig;
  private hullBody: Body;
  /** The winch block, or null if no winch waypoint was specified. */
  private winch: RopeBlock | null = null;
  /** All blocks and winches on this sheet. */
  private blocks: RopeBlock[] = [];
  private opacity: number = 1.0;
  /** Cumulative winch handle rotation (radians). */
  private winchAngle: number = 0;
  /** Previous working length, for computing winch rotation delta. */
  private prevWorkingLength: number = -1;
  /** Tick counter used to suppress spurious snap sounds on spawn. */
  private tickCount: number = 0;

  constructor(
    bodyA: Body,
    private localAnchorA: V3d,
    bodyB: Body,
    private localAnchorB: V3d,
    config: Partial<SheetConfig> = {},
    waypoints: SheetWaypoint[] = [],
    // Rendering-only hull plumbing: the RopeRender uses these to clamp
    // sample z-values above the deck surface.
    private getDeckHeight?: (localX: number, localY: number) => number | null,
    private hullBoundary?: HullBoundaryData,
  ) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.hullBody = bodyB;

    // Compute total path distance so we can size the rope.
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

    // Total rope length: enough for max working length plus tail.
    const totalRopeLength = Math.max(
      this.config.maxLength * 1.3,
      totalPathDist * 1.3,
    );

    // Build node specs: [clew endpoint, ...waypoints, tail endpoint].
    const nodeSpecs: RopeNetworkNodeSpec[] = [
      { body: bodyA, localAnchor: localAnchorA, kind: "endpoint" },
      ...waypoints.map(
        (wp): RopeNetworkNodeSpec => ({
          body: wp.body,
          localAnchor: wp.localAnchor,
          kind: wp.type === "winch" ? "winch" : "block",
          mu: wp.frictionCoefficient ?? 0,
        }),
      ),
      { body: bodyB, localAnchor: localAnchorB, kind: "endpoint" },
    ];

    this.rope = this.addChild(
      new RopeNetwork(nodeSpecs, { totalLength: totalRopeLength }),
    );
    this.render = new RopeRender(this.rope, {
      hullBody: this.hullBody,
      getDeckHeight: this.getDeckHeight,
      hullBoundary: this.hullBoundary,
      ropeRadius: (this.config.ropeDiameter ?? 0.026) / 2,
      // Rope wrap radius — the groove sits inboard of the cheek disks
      // (cheek radius is 0.3 ft in BoatRenderer), so the rope hugs a
      // smaller drum nested inside the visible hardware.
      winchRadius: 0.18,
      blockRadius: 0.18,
    });

    // Wrap each waypoint with a RopeBlock adapter. Must match by (body, localAnchor).
    // Winch max-force comes from the config's `winchForce` (lbf, converted
    // to engine units) so a player cranking against a taut sheet stalls
    // instead of spiking tension unbounded.
    const winchMaxForceEngine =
      this.config.winchForce != null
        ? this.config.winchForce * LBF_TO_ENGINE
        : undefined;
    for (const wp of waypoints) {
      const block = this.addChild(
        new RopeBlock(this.rope, wp.body, wp.localAnchor, {
          mode: wp.type ?? "block",
          frictionCoefficient: wp.frictionCoefficient,
          winchMaxForce: wp.type === "winch" ? winchMaxForceEngine : undefined,
        }),
      );
      this.blocks.push(block);
      if (block.type === "winch" && !this.winch) {
        this.winch = block;
      }
    }
  }

  /**
   * Current material length of rope on the sail side of the winch.
   */
  getWorkingLength(): number {
    if (!this.winch) return this.rope.getTotalLength();
    return this.winch.getWorkingLength();
  }

  /**
   * Adjust sheet length based on player input.
   *
   * When trimming (input < 0): ratchet + positive flow rate (length flows
   * working → tail). When easing (input > 0): free mode + zero flow; sail
   * loads pull rope out naturally. When idle (input = 0): ratchet + zero
   * flow; rope locked against easing.
   *
   * @param input Negative = trim in, positive = ease out.
   *   Magnitude controls speed: 1 = normal, >1 = grinding harder.
   */
  adjust(input: number): void {
    if (!this.winch) return;

    if (input === 0) {
      this.winch.setMode("ratchet");
      this.winch.applyTrimRate(0);
      return;
    }

    const workingLen = this.winch.getWorkingLength();
    if (input < 0 && workingLen <= this.config.minLength) {
      this.winch.applyTrimRate(0);
      return;
    }
    if (input > 0 && workingLen >= this.config.maxLength) {
      this.winch.applyTrimRate(0);
      return;
    }

    const maxSpeed = this.config.winchMaxSpeed ?? DEFAULT_CONFIG.winchMaxSpeed!;

    if (input < 0) {
      // Trimming: ratchet + positive flow rate.
      this.winch.setMode("ratchet");
      const rate = Math.min(1, Math.abs(input)) * maxSpeed;
      this.winch.applyTrimRate(rate);
    } else {
      // Easing: free + zero flow. Sail loads carry the rope out on their own.
      this.winch.setMode("free");
      this.winch.applyTrimRate(0);
    }
  }

  /**
   * Release the sheet for tacking. Clears winch grip so sail loads can pull
   * rope out freely.
   */
  release(): void {
    if (!this.winch) return;
    this.winch.setMode("free");
    this.winch.applyTrimRate(0);
  }

  getSheetPosition(): number {
    const workingLen = this.getWorkingLength();
    const range = this.config.maxLength - this.config.minLength;
    return clamp((workingLen - this.config.minLength) / (range || 1), 0, 1);
  }

  getSheetLength(): number {
    return this.getWorkingLength();
  }

  /** Set the visual opacity of the sheet (0 = invisible, 1 = fully visible). */
  setOpacity(opacity: number): void {
    this.opacity = clamp(opacity, 0, 1);
  }

  /** Check if sheet is fully eased out (at max working length). */
  isAtMaxLength(): boolean {
    return this.getSheetPosition() >= 0.99;
  }

  /**
   * Whether the working-side section is currently under tension. Used by
   * the sound system to detect sheet snap.
   */
  isWorkingTaut(): boolean {
    if (this.tickCount < 2) return false; // suppress spawn transients
    return this.getWorkingTension() > 0;
  }

  /**
   * Peak tension in sections adjacent to the winch (or the working
   * endpoint section if no winch). Engine-force units.
   */
  getWorkingTension(): number {
    if (this.winch) {
      return this.rope.getPeakTensionAt(this.winch.getNodeIndex());
    }
    // Fallback: peak across all sections.
    let peak = 0;
    for (let i = 0; i < this.rope.getSectionCount(); i++) {
      peak = Math.max(peak, this.rope.getSectionTension(i));
    }
    return peak;
  }

  @on("tick")
  onTick({
    dt,
  }: import("../../core/entity/Entity").GameEventMap["tick"]): void {
    this.tickCount++;
    this.updateWinchAngle();
    this.render.update(dt);
  }

  /** Update winch handle rotation based on rope length change. */
  private updateWinchAngle(): void {
    if (!this.winch) return;
    const len = this.winch.getWorkingLength();
    if (this.prevWorkingLength >= 0) {
      const delta = this.prevWorkingLength - len;
      // Geared down: one full handle turn per ~6ft of rope travel.
      this.winchAngle += delta / (6 / (2 * Math.PI));
    }
    this.prevWorkingLength = len;
  }

  /**
   * Get world-space rope render samples: points, z, and per-point material-v
   * coordinates. Variable-spaced (non-uniform along the rope) — callers must
   * consume `vPerPoint` rather than multiplying by `getRopeSegmentLength()`.
   */
  getRopePointsWithZ(): {
    points: [number, number][];
    z: number[];
    vPerPoint: number[];
  } {
    return this.render.computeSamples();
  }

  /** Stable total sample count for this sheet's render (for buffer sizing). */
  getRopeRenderSampleCount(): number {
    return this.render.getTotalSampleCount();
  }

  /** Get visual opacity. */
  getOpacity(): number {
    return this.opacity;
  }

  /** Z-height at anchor A (sail end). */
  getZA(): number {
    return this.localAnchorA[2];
  }

  /** Z-height at anchor B (tail end). */
  getZB(): number {
    return this.localAnchorB[2];
  }

  /** Waypoint info for rendering — world position, type, and winch angle. */
  getWaypointInfo(): {
    position: V3d;
    type: "block" | "winch";
    winchAngle: number;
  }[] {
    return this.blocks.map((b) => ({
      position: b.getWorldPosition(),
      type: b.type,
      winchAngle: b.type === "winch" ? this.winchAngle : 0,
    }));
  }

  /**
   * Reference material length per render segment. In the capstan model,
   * sections are non-uniform, so this returns an average — used only for
   * material-v spacing in the rope shader.
   */
  getRopeSegmentLength(): number {
    const n = this.rope.getNodeCount();
    if (n < 2) return 1;
    return this.rope.getTotalLength() / (n - 1);
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
