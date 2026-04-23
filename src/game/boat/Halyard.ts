import { BaseEntity } from "../../core/entity/BaseEntity";
import type { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import type { Body } from "../../core/physics/body/Body";
import type { HullBoundaryData } from "../../core/physics/constraints/DeckContactConstraint";
import { clamp } from "../../core/util/MathUtil";
import { V3d } from "../../core/Vector3";
import { RopeNetwork, type RopeNetworkNodeSpec } from "../rope/RopeNetwork";
import { RopeRender } from "../rope/RopeRender";
import type { RopePattern } from "./RopeShader";

export interface HalyardRenderConfig {
  /** Rope thickness in world ft. Default 0.15 — matches sheet ropes. */
  ropeThickness?: number;
  /** Fallback solid color if no ropePattern is specified. */
  ropeColor?: number;
  /** Optional custom carrier pattern. */
  ropePattern?: RopePattern;
  /** Rope diameter (ft) — controls floor-clamp offset. Default matches ropeThickness. */
  ropeDiameter?: number;
  /** Sheave drum radius for the block wrap at the mast top (ft). Default 0.12. */
  sheaveRadius?: number;
  /**
   * Slack fraction applied to the rope's rest length relative to the
   * chord. Can be negative: a small negative value makes the rest length
   * shorter than the chord, so PBD distance constraints actively pull
   * the rope together. With pinned endpoints the chain can't actually
   * contract, but the constraint's pull-together force counteracts
   * gravity sag and reads as a taut line under load. Default -0.01
   * (1 % pre-tension) — right for a halyard holding sail weight.
   */
  slackRatio?: number;
}

/**
 * Visual halyard: a rope from a deck cleat up the mast, over a sheave
 * block at the masthead, and back down to the sail head. All three anchors
 * ride the hull body, so the rope tilts with the boat. With a small slack
 * seed the capstan solver produces near-zero tension — the halyard is
 * physics-inert, pure decoration.
 */
export interface HalyardHeadTracker {
  /** Current world-unit z-height of the sail head (ft). */
  getHeadZ: () => number;
  /**
   * Lowest z the head ever reaches. Used to size the rope long enough that
   * the descending section can stretch all the way down without running
   * out of material.
   */
  minHeadZ: number;
}

export class Halyard extends BaseEntity {
  layer = "boat" as const;
  private rope: RopeNetwork;
  private render: RopeRender;
  private opacity = 1.0;
  private ropeThickness: number;
  private ropeColor: number;
  private ropePattern: RopePattern | undefined;
  private slackRatio: number;
  private headTracker: HalyardHeadTracker | null;
  /**
   * Reference descending-section length used to anchor the sail-end's
   * material-v coordinate. As the sail is hoisted and section 1 shrinks,
   * we offset every emitted v by `(maxDescent − currentDescent)` so the
   * sail end keeps a constant material-v — the rope visually appears to
   * slide through the sheave instead of shrinking on the sail side.
   */
  private maxDescentLength: number;

  constructor(
    hullBody: Body,
    cleatAnchor: V3d,
    sheaveAnchor: V3d,
    headAnchor: V3d,
    config: HalyardRenderConfig = {},
    getDeckHeight?: (localX: number, localY: number) => number | null,
    hullBoundary?: HullBoundaryData,
    headTracker?: HalyardHeadTracker,
  ) {
    super();
    this.ropeThickness = config.ropeThickness ?? 0.15;
    this.ropeColor = config.ropeColor ?? 0xeeeeee;
    this.ropePattern = config.ropePattern;
    const ropeDiameter = config.ropeDiameter ?? this.ropeThickness;
    const sheaveRadius = config.sheaveRadius ?? 0.12;
    this.slackRatio = config.slackRatio ?? -0.01;
    this.headTracker = headTracker ?? null;

    const nodeSpecs: RopeNetworkNodeSpec[] = [
      { body: hullBody, localAnchor: cleatAnchor, kind: "endpoint" },
      { body: hullBody, localAnchor: sheaveAnchor, kind: "block" },
      { body: hullBody, localAnchor: headAnchor, kind: "endpoint" },
    ];

    const ascentChord = chord(cleatAnchor, sheaveAnchor);
    // Size the rope for the maximum possible descending chord so that
    // furling the sail (which drops the head down the mast) doesn't
    // stretch the rope taut.
    const worstHeadZ = headTracker ? headTracker.minHeadZ : headAnchor[2];
    const worstHead = new V3d(headAnchor[0], headAnchor[1], worstHeadZ);
    const maxDescentChord = chord(sheaveAnchor, worstHead);
    this.maxDescentLength = maxDescentChord * (1 + this.slackRatio);
    const totalRopeLength =
      (ascentChord + maxDescentChord) * (1 + this.slackRatio);

    this.rope = this.addChild(
      new RopeNetwork(nodeSpecs, { totalLength: totalRopeLength }),
    );
    // Override the RopeNetwork constructor's hardcoded 5% working-slack
    // seed — halyards read as taut lines, not catenaries. The ascending
    // chord is fixed (both anchors on the hull), so this value is set
    // once here; the descending section is re-set every tick as the head
    // moves with the hoist.
    this.rope.getSection(0).length = ascentChord * (1 + this.slackRatio);
    const initialDescent = chord(sheaveAnchor, headAnchor);
    this.rope.getSection(1).length = initialDescent * (1 + this.slackRatio);

    this.render = new RopeRender(this.rope, {
      hullBody,
      getDeckHeight,
      hullBoundary,
      ropeRadius: ropeDiameter / 2,
      blockRadius: sheaveRadius,
      // Few particles per section — a halyard should read as a taut
      // straight line, and PBD convergence is dramatically better with
      // short chains (rate ≈ 1 − 2π²/N² per iteration). 4 particles is
      // enough for Catmull-Rom subdivision to produce a smooth curve
      // around the sheave wrap, while keeping residual sag invisible.
      particlesPerSection: 6,
    });
  }

  @on("tick")
  onTick({ dt }: GameEventMap["tick"]): void {
    if (this.headTracker) {
      this.syncHeadAnchor();
    }
    this.render.update(dt);
  }

  /**
   * Mutate the head node's anchor z and the descending section's rest
   * length so the halyard tracks the sail head as it rises or falls with
   * the hoist. Without this, the descending section's length is fixed at
   * construction and the rope either slacks into a loop or gets visibly
   * stretched when the head moves.
   */
  private syncHeadAnchor(): void {
    if (!this.headTracker) return;
    const headNode = this.rope.getNode(2);
    const sheaveNode = this.rope.getNode(1);
    headNode.localAnchor[2] = this.headTracker.getHeadZ();
    const dx = sheaveNode.localAnchor[0] - headNode.localAnchor[0];
    const dy = sheaveNode.localAnchor[1] - headNode.localAnchor[1];
    const dz = sheaveNode.localAnchor[2] - headNode.localAnchor[2];
    const descentChord = Math.sqrt(dx * dx + dy * dy + dz * dz);
    this.rope.getSection(1).length = descentChord * (1 + this.slackRatio);
  }

  setOpacity(opacity: number): void {
    this.opacity = clamp(opacity, 0, 1);
  }

  getOpacity(): number {
    return this.opacity;
  }

  getRopePointsWithZ(): {
    points: [number, number][];
    z: number[];
    vPerPoint: number[];
  } {
    const samples = this.render.computeSamples();
    // Shift every v-coord so the sail end stays at a constant material
    // position. The rope shader's pattern is periodic in v, so a uniform
    // shift makes the pattern scroll along the rope axis — exactly the
    // look of material flowing through the sheave as the sail is hoisted
    // or furled. Ascending length is fixed; only the descending section
    // shortens, so the offset is driven entirely by section 1.
    const currentDescent = this.rope.getSection(1).length;
    const vOffset = this.maxDescentLength - currentDescent;
    if (vOffset !== 0) {
      const vs = samples.vPerPoint;
      for (let i = 0; i < vs.length; i++) vs[i] += vOffset;
    }
    return samples;
  }

  getRopeRenderSampleCount(): number {
    return this.render.getTotalSampleCount();
  }

  getRopeThickness(): number {
    return this.ropeThickness;
  }

  getRopePattern(): RopePattern {
    return this.ropePattern ?? { type: "laid", carriers: [this.ropeColor] };
  }
}

function chord(a: V3d, b: V3d): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
